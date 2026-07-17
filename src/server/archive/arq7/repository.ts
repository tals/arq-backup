import { randomUUID } from "node:crypto";
import type { ArchiveEntrySummary, BackupFolderSummary, BackupRecordSummary } from "../../../shared/contracts";
import type { CloudBucket } from "../../../shared/contracts";
import { CloudProviderError, type CloudObject, type CloudStorageProvider } from "../../cloud/provider";
import { decryptArq7Object, type Arq7KeySet } from "./crypto";
import { inflateArqLz4 } from "../common/lz4";
import { ArchiveFormatError } from "../common/errors";
import { parseBackupRecord, type Arq7BackupRecord, type Arq7BlobLocation } from "./models";
import { parseTree } from "./tree";

type RegisteredNode = { backupFolderId: string; name: string; node: import("./models").Arq7Node; complete: boolean };

export class Arq7Repository {
  readonly #records = new Map<string, Arq7BackupRecord>();
  readonly #nodes = new Map<string, RegisteredNode>();
  readonly #children = new Map<string, ArchiveEntrySummary[]>();

  constructor(
    readonly provider: CloudStorageProvider,
    readonly bucket: CloudBucket,
    readonly planId: string,
    readonly keySet: Arq7KeySet,
  ) {}

  async listBackupFolders(): Promise<BackupFolderSummary[]> {
    const prefix = `${this.planId}/backupfolders/`;
    const objects = await this.#listAll({ prefix, delimiter: "/" });
    const folderIds = objects
      .filter(object => object.kind === "folder" && object.name.endsWith("/"))
      .map(object => object.name.slice(prefix.length, -1))
      .filter(Boolean);
    const folders = await Promise.all(folderIds.map(folderId => this.#openFolder(folderId)));
    return folders.sort((left, right) => left.name.localeCompare(right.name));
  }

  async readBlob(location: Arq7BlobLocation, backupFolderId?: string): Promise<Uint8Array> {
    const start = location.offset;
    const endInclusive = location.offset + location.length - 1;
    if (location.isPacked && (!Number.isSafeInteger(endInclusive) || location.length <= 0)) {
      throw new ArchiveFormatError("invalid_blob_location", "The Arq 7 blob location has an invalid byte range");
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
      const compatibility = `${this.planId}/backupfolders/${backupFolderId}/${location.relativePath.replace(/^\/+/, "")}`;
      encrypted = await this.provider.readObject(
        this.bucket,
        compatibility,
        location.isPacked ? { range: { start, endInclusive } } : undefined,
      );
    }
    if (location.isPacked && encrypted.byteLength !== location.length) {
      throw new ArchiveFormatError("invalid_blob_range", "B2 returned an unexpected byte count for an Arq 7 blob range");
    }
    const decrypted = startsWithArqo(encrypted) ? decryptArq7Object(encrypted, this.keySet) : encrypted;
    try {
      const output = decompress(decrypted, location.compressionType);
      return output;
    } finally {
      if (location.compressionType !== 0) decrypted.fill(0);
    }
  }

  async listChildren(token: string): Promise<ArchiveEntrySummary[]> {
    const cached = this.#children.get(token);
    if (cached) return cached;
    const registered = this.#nodes.get(token);
    if (!registered) throw new ArchiveFormatError("missing_archive_node", "The selected archive node is no longer in this session");
    if (!registered.node.isTree || !registered.node.treeBlobLoc) {
      throw new ArchiveFormatError("not_a_folder", "The selected archive node is not a folder");
    }
    const bytes = await this.readBlob(registered.node.treeBlobLoc, registered.backupFolderId);
    try {
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
    if (!registered.complete) throw new ArchiveFormatError("incomplete_backup", "This Backup Record is incomplete and cannot be restored");
    if (registered.node.isSparse) throw new ArchiveFormatError("unsupported_sparse_file", "Sparse-file restoration is not implemented for this archived item");
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
      "arq7",
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
    if (!registered.complete) throw new ArchiveFormatError("incomplete_backup", "This Backup Record is incomplete and cannot be restored");
    if (registered.node.isSparse) throw new ArchiveFormatError("unsupported_sparse_file", "Sparse-file restoration is not implemented for this archived item");
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
    this.#records.clear();
    this.#nodes.clear();
    this.#children.clear();
    this.keySet.destroy();
  }

  async #openFolder(folderId: string): Promise<BackupFolderSummary> {
    const metadata = await this.#readFolderMetadata(folderId);
    const recordObject = await this.#latestRecordObject(folderId);
    if (!recordObject) {
      return { id: folderId, name: metadata.name ?? folderId, localPath: metadata.localPath, latestRecord: null };
    }
    const encrypted = await this.provider.readObject(this.bucket, recordObject.name);
    const record = parseBackupRecord(inflateArqLz4(decryptArq7Object(encrypted, this.keySet)));
    if (record.backupFolderUUID !== folderId || record.backupPlanUUID !== this.planId) {
      throw new ArchiveFormatError("mismatched_backup_record", "An Arq 7 backup record belongs to a different plan or folder");
    }
    this.#records.set(recordObject.name, record);
    const name = metadata.name ?? (record.volumeName?.trim() || lastPathComponent(record.localPath) || folderId);
    const root = this.#registerNode(folderId, name, record.node, record.isComplete);
    const latestRecord: BackupRecordSummary = {
      id: recordObject.name,
      createdAt: new Date(record.creationDate * 1_000).toISOString(),
      complete: record.isComplete,
      root,
    };
    return { id: folderId, name, localPath: metadata.localPath ?? record.localPath, latestRecord };
  }

  async #readFolderMetadata(folderId: string): Promise<{ name: string | null; localPath: string | null }> {
    const objectName = `${this.planId}/backupfolders/${folderId}/backupfolder.json`;
    const encrypted = await this.provider.readObject(this.bucket, objectName);
    const decrypted = decryptArq7Object(encrypted, this.keySet);
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decrypted)) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      const metadata = value as Record<string, unknown>;
      return {
        name: typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : null,
        localPath: typeof metadata.localPath === "string" ? metadata.localPath : null,
      };
    } catch {
      throw new ArchiveFormatError("invalid_backup_folder", "The Arq 7 backup folder metadata is not valid JSON");
    } finally {
      decrypted.fill(0);
    }
  }

  #registerNode(
    backupFolderId: string,
    name: string,
    node: import("./models").Arq7Node,
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

  #entrySummary(token: string, name: string, node: import("./models").Arq7Node): ArchiveEntrySummary {
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

  async #latestRecordObject(folderId: string): Promise<CloudObject | null> {
    const prefix = `${this.planId}/backupfolders/${folderId}/backuprecords/`;
    const groups = (await this.#listAll({ prefix, delimiter: "/" }))
      .filter(object => object.kind === "folder" && /^\d{5}\/$/.test(object.name.slice(prefix.length)))
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const group of groups) {
      const records = (await this.#listAll({ prefix: group.name }))
        .filter(object => object.kind === "file" && /^\d{7}\.backuprecord$/.test(object.name.slice(group.name.length)))
        .sort((left, right) => right.name.localeCompare(left.name));
      if (records[0]) return records[0];
    }
    return null;
  }

  async #listAll(options: { prefix: string; delimiter?: string }): Promise<CloudObject[]> {
    const objects: CloudObject[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.provider.listObjects(this.bucket, { ...options, cursor, limit: 10_000 });
      objects.push(...page.objects);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return objects;
  }
}

function startsWithArqo(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x41 && bytes[1] === 0x52 && bytes[2] === 0x51 && bytes[3] === 0x4f;
}

function decompress(bytes: Uint8Array, compressionType: 0 | 1 | 2): Uint8Array {
  if (compressionType === 0) return bytes;
  if (compressionType === 1) {
    try {
      return Bun.gunzipSync(Uint8Array.from(bytes));
    } catch {
      throw new ArchiveFormatError("invalid_compressed_blob", "An Arq 7 gzip blob could not be decompressed");
    }
  }
  return inflateArqLz4(bytes);
}

function lastPathComponent(path: string): string | null {
  return path.replace(/\/+$/, "").split("/").at(-1) || null;
}

function timestamp(seconds: number, nanoseconds: number): string {
  return new Date(seconds * 1_000 + Math.floor(nanoseconds / 1_000_000)).toISOString();
}
