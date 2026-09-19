import { createHash, randomUUID } from "node:crypto";
import type { ArchiveEntrySummary, BackupFolderSummary, CloudBucket } from "../../../shared/contracts";
import { CloudProviderError, type CloudObject, type CloudStorageProvider } from "../../cloud/provider";
import { decryptArq7Object, type Arq7KeySet } from "../arq7/crypto";
import type { Arq7BlobLocation, Arq7Node } from "../arq7/models";
import { parseTree } from "../arq7/tree";
import { ArchiveFormatError } from "../common/errors";
import { inflateArqLz4 } from "../common/lz4";

type RegisteredNode = { backupFolderId: string; name: string; node: Arq7Node; complete: boolean };

export abstract class ModernArqRepository {
  readonly #nodes = new Map<string, RegisteredNode>();
  readonly #children = new Map<string, ArchiveEntrySummary[]>();
  readonly #childrenInFlight = new Map<string, Promise<ArchiveEntrySummary[]>>();
  #blobIdentifierTypePromise: Promise<1 | 2> | null = null;
  #destroyed = false;

  protected constructor(
    readonly provider: CloudStorageProvider,
    readonly bucket: CloudBucket,
    readonly planId: string,
    readonly keySet: Arq7KeySet,
    readonly format: "arq6" | "arq7",
    readonly formatName: "Arq 6" | "Arq 7",
  ) {}

  abstract listBackupFolders(): Promise<BackupFolderSummary[]>;

  async readBlob(location: Arq7BlobLocation, backupFolderId?: string): Promise<Uint8Array> {
    const blobIdentifierType = await this.#blobIdentifierType();
    const start = location.offset;
    const endInclusive = location.offset + location.length - 1;
    if (location.isPacked && (!Number.isSafeInteger(endInclusive) || location.length <= 0)) {
      throw new ArchiveFormatError("invalid_blob_location", `The ${this.formatName} blob location has an invalid byte range`);
    }
    const relative = location.relativePath.replace(/^\/+/, "");
    const primary = relative.startsWith(`${this.planId}/`) ? relative : `${this.planId}/${relative}`;
    let encrypted: Uint8Array;
    try {
      encrypted = await this.provider.readObject(
        this.bucket,
        primary,
        location.isPacked ? { range: { start, endInclusive } } : undefined,
      );
    } catch (error) {
      if (!backupFolderId || !(error instanceof CloudProviderError) || error.status !== 404) throw error;
      const compatibility = `${this.planId}/backupfolders/${backupFolderId}/${relative}`;
      encrypted = await this.provider.readObject(
        this.bucket,
        compatibility,
        location.isPacked ? { range: { start, endInclusive } } : undefined,
      );
    }
    if (location.isPacked && encrypted.byteLength !== location.length) {
      throw new ArchiveFormatError("invalid_blob_range", `B2 returned an unexpected byte count for a ${this.formatName} blob range`);
    }
    const decrypted = startsWithArqo(encrypted) ? decryptArq7Object(encrypted, this.keySet) : encrypted;
    let output: Uint8Array | null = null;
    try {
      output = decompress(decrypted, location.compressionType, this.formatName);
      const algorithm = blobIdentifierType === 1 ? "sha1" : "sha256";
      const actualIdentifier = createHash(algorithm)
        .update(this.keySet.blobIdSalt)
        .update(output)
        .digest("hex");
      if (actualIdentifier !== location.blobIdentifier.toLowerCase()) {
        throw new ArchiveFormatError(
          "blob_integrity_failed",
          `The ${this.formatName} object ${location.blobIdentifier} failed its salted ${algorithm.toUpperCase()} integrity check`,
        );
      }
      return output;
    } catch (error) {
      output?.fill(0);
      throw error;
    } finally {
      if (output !== decrypted) decrypted.fill(0);
    }
  }

  async listChildren(token: string): Promise<ArchiveEntrySummary[]> {
    this.#assertActive();
    const cached = this.#children.get(token);
    if (cached) return cached;
    const active = this.#childrenInFlight.get(token);
    if (active) return active;
    const loading = this.#loadChildren(token).finally(() => {
      if (this.#childrenInFlight.get(token) === loading) this.#childrenInFlight.delete(token);
    });
    this.#childrenInFlight.set(token, loading);
    return loading;
  }

  async #loadChildren(token: string): Promise<ArchiveEntrySummary[]> {
    this.#assertActive();
    const registered = this.#nodes.get(token);
    if (!registered) throw new ArchiveFormatError("missing_archive_node", "The selected archive node is no longer in this session");
    if (!registered.node.isTree || !registered.node.treeBlobLoc) {
      throw new ArchiveFormatError("not_a_folder", "The selected archive node is not a folder");
    }
    const bytes = await this.readBlob(registered.node.treeBlobLoc, registered.backupFolderId);
    try {
      this.#assertActive();
      const tree = parseTree(bytes);
      const children = tree.entries
        .filter(entry => !entry.node.deleted)
        .map(entry => this.#registerNode(registered.backupFolderId, entry.name, entry.node, registered.complete, entry.token));
      this.#children.set(token, children);
      return children;
    } finally {
      bytes.fill(0);
    }
  }

  getEntry(token: string): ArchiveEntrySummary {
    const registered = this.#registeredNode(token);
    if (!registered.complete) throw new ArchiveFormatError("incomplete_backup", "This backup snapshot is incomplete and cannot be restored");
    return this.#entrySummary(token, registered.name, registered.node);
  }

  restoreIdentity(token: string): string {
    const { backupFolderId, node } = this.#registeredNode(token);
    const blobs = node.dataBlobLocs.map(location => [
      location.blobIdentifier,
      location.relativePath,
      location.offset,
      location.length,
      location.compressionType,
    ].join(":"));
    return [
      this.format,
      this.provider.connectionId,
      this.bucket.id,
      this.planId,
      backupFolderId,
      node.isTree ? "folder" : "data",
      blobs.join(","),
      node.itemSize,
      node.modificationTimeSeconds,
      node.modificationTimeNanoseconds,
      node.mode,
    ].join("\0");
  }

  describeRestoreItem(token: string) {
    const registered = this.#registeredNode(token);
    return {
      entry: this.getEntry(token),
      identity: this.restoreIdentity(token),
      modifiedSeconds: registered.node.modificationTimeSeconds,
      modifiedNanoseconds: registered.node.modificationTimeNanoseconds,
    };
  }

  async *readData(token: string): AsyncIterable<Uint8Array> {
    const registered = this.#registeredNode(token);
    if (!registered.complete) throw new ArchiveFormatError("incomplete_backup", "This backup snapshot is incomplete and cannot be restored");
    if (registered.node.isTree) throw new ArchiveFormatError("not_file_data", "A folder has no restorable file data");
    for (const location of registered.node.dataBlobLocs) {
      const bytes = await this.readBlob(location, registered.backupFolderId);
      try {
        yield bytes;
      } finally {
        bytes.fill(0);
      }
    }
  }

  destroy(): void {
    this.#destroyed = true;
    this.#nodes.clear();
    this.#children.clear();
    this.#childrenInFlight.clear();
    this.keySet.destroy();
  }

  protected registerRoot(
    backupFolderId: string,
    name: string,
    node: Arq7Node,
    complete: boolean,
  ): ArchiveEntrySummary {
    return this.#registerNode(backupFolderId, name, node, complete);
  }

  protected async listAll(options: { prefix: string; delimiter?: string }): Promise<CloudObject[]> {
    const objects: CloudObject[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.provider.listObjects(this.bucket, { ...options, cursor, limit: 10_000 });
      objects.push(...page.objects);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return objects;
  }

  async #blobIdentifierType(): Promise<1 | 2> {
    const active = this.#blobIdentifierTypePromise;
    if (active) return active;
    const loading = this.#readBlobIdentifierType();
    this.#blobIdentifierTypePromise = loading;
    try {
      return await loading;
    } catch (error) {
      if (this.#blobIdentifierTypePromise === loading) this.#blobIdentifierTypePromise = null;
      throw error;
    }
  }

  async #readBlobIdentifierType(): Promise<1 | 2> {
    const bytes = await this.provider.readObject(this.bucket, `${this.planId}/backupconfig.json`);
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      const candidate = (value as Record<string, unknown>).blobIdentifierType;
      if (candidate !== 1 && candidate !== 2) {
        throw new ArchiveFormatError(
          "unsupported_blob_identifier_type",
          `The ${this.formatName} backup config has an unsupported blob identifier type`,
        );
      }
      return candidate;
    } catch (error) {
      if (error instanceof ArchiveFormatError) throw error;
      throw new ArchiveFormatError(
        "invalid_backup_config",
        `The ${this.formatName} backup config is not valid UTF-8 JSON`,
      );
    } finally {
      bytes.fill(0);
    }
  }

  #registerNode(
    backupFolderId: string,
    name: string,
    node: Arq7Node,
    complete: boolean,
    token: string = randomUUID(),
  ): ArchiveEntrySummary {
    this.#nodes.set(token, { backupFolderId, name, node, complete });
    return this.#entrySummary(token, name, node);
  }

  #registeredNode(token: string): RegisteredNode {
    const registered = this.#nodes.get(token);
    if (!registered) throw new ArchiveFormatError("missing_archive_node", "The selected archive node is no longer in this session");
    return registered;
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new ArchiveFormatError("missing_archive_node", "This archive session has been locked");
    }
  }

  #entrySummary(token: string, name: string, node: Arq7Node): ArchiveEntrySummary {
    const fileType = node.mode & 0o170000;
    return {
      token,
      name,
      kind: node.isTree ? "folder" : fileType === 0o120000 ? "symlink" : "file",
      size: node.itemSize,
      modifiedAt: timestamp(node.modificationTimeSeconds, node.modificationTimeNanoseconds),
      mode: node.mode,
      containedFiles: node.containedFilesCount,
    };
  }
}

export function startsWithArqo(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x41 && bytes[1] === 0x52 && bytes[2] === 0x51 && bytes[3] === 0x4f;
}

function decompress(bytes: Uint8Array, compressionType: 0 | 1 | 2, formatName: string): Uint8Array {
  if (compressionType === 0) return bytes;
  if (compressionType === 1) {
    try {
      return Bun.gunzipSync(Uint8Array.from(bytes));
    } catch {
      throw new ArchiveFormatError("invalid_compressed_blob", `A ${formatName} gzip blob could not be decompressed`);
    }
  }
  return inflateArqLz4(bytes);
}

function timestamp(seconds: number, nanoseconds: number): string {
  return new Date(seconds * 1_000 + Math.floor(nanoseconds / 1_000_000)).toISOString();
}
