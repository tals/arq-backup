import { createHash, randomUUID } from "node:crypto";
import type {
  ArchiveEntrySummary,
  ArchiveUnlockProgress,
  BackupFolderSummary,
  BackupRecordSummary,
  CloudBucket,
} from "../../../shared/contracts";
import { CloudProviderError, type CloudObject, type CloudStorageProvider } from "../../cloud/provider";
import { inflateArqLz4 } from "../common/lz4";
import { ArchiveFormatError } from "../common/errors";
import { decryptArq5Object, type Arq5KeySet } from "./crypto";
import { parseArq5Commit, parseArq5Tree, type Arq5BlobKey, type Arq5Node } from "./models";
import { ARQ5_INDEX_CONCURRENCY, Arq5PackSet, type Arq5PackSetProgressEvent } from "./pack-set";

const ENCRYPTED_PREFIX = Buffer.from("encrypted", "ascii");

type FolderMetadata = { id: string; name: string; localPath: string | null };
type FolderHead = { metadata: FolderMetadata; head: Arq5BlobKey | null };
type RegisteredNode = { folderId: string; name: string; node: Arq5Node; complete: boolean };

export class Arq5Repository {
  readonly #nodes = new Map<string, RegisteredNode>();
  readonly #children = new Map<string, ArchiveEntrySummary[]>();
  readonly #childrenInFlight = new Map<string, Promise<ArchiveEntrySummary[]>>();
  readonly #treePackSets = new Map<string, Arq5PackSet>();
  readonly #blobPackSets = new Map<string, Arq5PackSet>();
  readonly #indexReads = new AsyncLimiter(ARQ5_INDEX_CONCURRENCY);
  readonly #unlockProgress: ArchiveUnlockProgress = {
    phase: "indexing_legacy_tree_packs",
    indexTotalKnown: false,
    indexedPackIndexes: 0,
    totalPackIndexes: 0,
    packCacheMisses: 0,
    downloadedPacks: 0,
  };
  #publishUnlockProgress = false;
  #destroyed = false;

  constructor(
    readonly provider: CloudStorageProvider,
    readonly bucket: CloudBucket,
    readonly planId: string,
    readonly keySet: Arq5KeySet,
    readonly onUnlockProgress?: (progress: ArchiveUnlockProgress) => void,
  ) {}

  async listBackupFolders(): Promise<BackupFolderSummary[]> {
    const metadata = await this.#listFolderMetadata();
    const folderHeads: FolderHead[] = await Promise.all(metadata.map(async folder => ({
      metadata: folder,
      head: await this.#readFolderHead(folder),
    })));
    const available = folderHeads.filter((folder): folder is FolderHead & { head: Arq5BlobKey } => folder.head !== null);
    await Promise.all(available.map(folder => this.#treePackSet(folder.metadata.id).discoverIndexes()));
    this.#unlockProgress.indexTotalKnown = true;
    this.#publishUnlockProgress = true;
    this.#emitUnlockProgress();
    const folders = await Promise.all(folderHeads.map(folder => folder.head
      ? this.#openFolder(folder.metadata, folder.head)
      : {
          id: folder.metadata.id,
          name: folder.metadata.name,
          localPath: folder.metadata.localPath,
          latestRecord: null,
        }));
    return folders.sort((left, right) => left.name.localeCompare(right.name));
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
    if (!registered) throw new ArchiveFormatError("missing_archive_node", "The selected Arq 5 node is no longer in this session");
    if (!registered.node.isTree || !registered.node.dataBlobKeys[0]) {
      throw new ArchiveFormatError("not_a_folder", "The selected Arq 5 node is not a folder");
    }
    const tree = await this.#readTree(registered.folderId, registered.node.dataBlobKeys[0]);
    this.#assertActive();
    registered.node.mode = tree.rootMode;
    registered.node.modifiedSeconds = tree.rootModifiedSeconds;
    registered.node.modifiedNanoseconds = tree.rootModifiedNanoseconds;
    const entries = [...tree.children].map(([name, node]) => this.#registerNode(registered.folderId, name, node, registered.complete));
    entries.sort((left, right) => Number(right.kind === "folder") - Number(left.kind === "folder") || left.name.localeCompare(right.name));
    this.#children.set(token, entries);
    return entries;
  }

  getEntry(token: string): ArchiveEntrySummary {
    const registered = this.#registeredNode(token);
    if (!registered.complete) throw new ArchiveFormatError("incomplete_backup", "This Backup Record is incomplete and cannot be restored");
    return this.#entrySummary(token, registered.name, registered.node);
  }

  restoreIdentity(token: string): string {
    const { folderId, node } = this.#registeredNode(token);
    return [
      "arq5",
      this.provider.connectionId,
      this.bucket.id,
      this.planId,
      folderId,
      node.isTree ? "folder" : "data",
      node.dataBlobKeys.map(key => `${key.sha1}:${key.compression}:${key.storageType}`).join(","),
      node.uncompressedSize.toString(),
      node.modifiedSeconds.toString(),
      node.modifiedNanoseconds.toString(),
      node.mode,
    ].join("\0");
  }

  describeRestoreItem(token: string) {
    const registered = this.#registeredNode(token);
    const entry = this.getEntry(token);
    return {
      entry,
      identity: this.restoreIdentity(token),
      modifiedSeconds: safeBigIntNumber(registered.node.modifiedSeconds, "modification time"),
      modifiedNanoseconds: safeBigIntNumber(registered.node.modifiedNanoseconds, "modification nanoseconds"),
    };
  }

  async *readData(token: string): AsyncIterable<Uint8Array> {
    const registered = this.#registeredNode(token);
    if (!registered.complete) throw new ArchiveFormatError("incomplete_backup", "This Backup Record is incomplete and cannot be restored");
    if (registered.node.isTree) throw new ArchiveFormatError("not_file_data", "A folder has no restorable file data");
    for (const key of registered.node.dataBlobKeys) {
      if (key.storageType !== 1) {
        throw new ArchiveFormatError("unavailable_storage", `Arq 5 object ${key.sha1} uses unavailable archival storage type ${key.storageType}`);
      }
      const encrypted = await this.#readBlobObject(registered.folderId, key.sha1);
      const decrypted = startsWith(encrypted, Buffer.from("ARQO"))
        ? decryptArq5Object(encrypted, this.keySet)
        : Uint8Array.from(encrypted);
      let output: Uint8Array | null = null;
      try {
        output = decompress(decrypted, key.compression, "file data");
        this.#assertBlobIdentifier(output, key.sha1, "file-data");
        yield output;
      } finally {
        decrypted.fill(0);
        if (output && output !== decrypted) output.fill(0);
      }
    }
  }

  destroy(): void {
    this.#destroyed = true;
    this.#nodes.clear();
    this.#children.clear();
    this.#childrenInFlight.clear();
    for (const packSet of this.#treePackSets.values()) packSet.destroy();
    for (const packSet of this.#blobPackSets.values()) packSet.destroy();
    this.#treePackSets.clear();
    this.#blobPackSets.clear();
    this.keySet.destroy();
  }

  async #listFolderMetadata(): Promise<FolderMetadata[]> {
    const prefix = `${this.planId}/buckets/`;
    const objects = await listAll(this.provider, this.bucket, prefix);
    const configs = objects.filter(object => object.kind === "file" && object.name.slice(prefix.length).match(/^[0-9a-f-]{36}$/i));
    return Promise.all(configs.map(async object => {
      const id = object.name.slice(prefix.length);
      const raw = await this.provider.readObject(this.bucket, object.name);
      let plaintext: Uint8Array;
      if (startsWith(raw, ENCRYPTED_PREFIX)) plaintext = decryptArq5Object(raw.subarray(ENCRYPTED_PREFIX.length), this.keySet);
      else plaintext = Uint8Array.from(raw);
      try {
        const xml = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
        const declaredId = plistString(xml, "BucketUUID");
        if (declaredId && declaredId.toLowerCase() !== id.toLowerCase()) {
          throw new ArchiveFormatError("mismatched_folder", "An Arq 5 folder configuration belongs to another folder");
        }
        return {
          id,
          name: plistString(xml, "BucketName") ?? lastPathComponent(plistString(xml, "LocalPath")) ?? id,
          localPath: plistString(xml, "LocalPath"),
        };
      } catch (error) {
        if (error instanceof ArchiveFormatError) throw error;
        throw new ArchiveFormatError("invalid_folder_config", "An Arq 5 folder configuration is not valid XML metadata");
      } finally {
        plaintext.fill(0);
      }
    }));
  }

  async #readFolderHead(metadata: FolderMetadata): Promise<Arq5BlobKey | null> {
    const headPath = `${this.planId}/bucketdata/${metadata.id}/refs/heads/master`;
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(await this.provider.readObject(this.bucket, headPath)).trim();
      const match = /^([0-9a-f]{40})(Y)?$/i.exec(value);
      if (!match) throw new ArchiveFormatError("invalid_head", "An Arq 5 folder head is not a SHA-1 reference");
      return { sha1: match[1]!.toLowerCase(), stretched: Boolean(match[2]), compression: 0, storageType: 1 };
    } catch (error) {
      if (error instanceof ArchiveFormatError) throw error;
      if (error instanceof CloudProviderError && error.status === 404) return null;
      throw error;
    }
  }

  async #openFolder(metadata: FolderMetadata, head: Arq5BlobKey): Promise<BackupFolderSummary> {
    const encryptedCommit = await this.#readTreeObject(metadata.id, head.sha1);
    const decryptedCommit = decryptArq5Object(encryptedCommit, this.keySet);
    let commit;
    try {
      this.#assertBlobIdentifier(decryptedCommit, head.sha1, "commit");
      commit = parseArq5Commit(decryptedCommit);
    } finally {
      decryptedCommit.fill(0);
    }
    if (commit.hasMissingNodes) {
      throw new ArchiveFormatError("incomplete_tree", "The latest Arq 5 Backup Record reports missing archived items");
    }
    const rootNode: Arq5Node = {
      isTree: true,
      containsMissingItems: false,
      dataBlobKeys: [commit.tree],
      uncompressedSize: 0n,
      mode: 0o040755,
      modifiedSeconds: BigInt(Math.floor(commit.createdAt.getTime() / 1_000)),
      modifiedNanoseconds: 0n,
    };
    const root = this.#registerNode(metadata.id, metadata.name, rootNode, commit.complete);
    const latestRecord: BackupRecordSummary = {
      id: head.sha1,
      createdAt: commit.createdAt.toISOString(),
      complete: commit.complete,
      root,
    };
    return { id: metadata.id, name: metadata.name, localPath: metadata.localPath ?? commit.location, latestRecord };
  }

  async #readTree(folderId: string, key: Arq5BlobKey) {
    const encrypted = await this.#readTreeObject(folderId, key.sha1);
    const decrypted = decryptArq5Object(encrypted, this.keySet);
    let decompressed: Uint8Array | null = null;
    try {
      decompressed = decompress(decrypted, key.compression, "tree");
      this.#assertBlobIdentifier(decompressed, key.sha1, "tree");
      return parseArq5Tree(decompressed);
    } finally {
      decrypted.fill(0);
      if (decompressed && decompressed !== decrypted) decompressed.fill(0);
    }
  }

  #treePackSet(folderId: string): Arq5PackSet {
    let packSet = this.#treePackSets.get(folderId);
    if (!packSet) {
      packSet = new Arq5PackSet(
        this.provider,
        this.bucket,
        `${this.planId}/packsets/${folderId}-trees/`,
        undefined,
        true,
        event => this.#reportUnlockProgress(event),
        action => this.#indexReads.run(action),
      );
      this.#treePackSets.set(folderId, packSet);
    }
    return packSet;
  }

  #blobPackSet(folderId: string): Arq5PackSet {
    let packSet = this.#blobPackSets.get(folderId);
    if (!packSet) {
      packSet = new Arq5PackSet(this.provider, this.bucket, `${this.planId}/packsets/${folderId}-blobs/`, null, false);
      this.#blobPackSets.set(folderId, packSet);
    }
    return packSet;
  }

  async #readTreeObject(folderId: string, sha1: string): Promise<Uint8Array> {
    return this.#readStoredObject(this.#treePackSet(folderId), sha1, "tree");
  }

  async #readBlobObject(folderId: string, sha1: string): Promise<Uint8Array> {
    return this.#readStoredObject(this.#blobPackSet(folderId), sha1, "file-data");
  }

  async #readStoredObject(packSet: Arq5PackSet, sha1: string, description: string): Promise<Uint8Array> {
    try {
      return await packSet.readObject(sha1);
    } catch (error) {
      if (!(error instanceof ArchiveFormatError) || error.code !== "missing_packed_object") throw error;
    }

    const candidates = [
      `${this.planId}/objects/${sha1}`,
      `${this.planId}/objects/${sha1.slice(0, 2)}/${sha1.slice(2)}`,
      `${this.planId}/objects2/${sha1.slice(0, 2)}/${sha1.slice(2)}`,
      `${this.planId}/objects/${sha1.slice(0, 2)}/${sha1.slice(2, 4)}/${sha1.slice(4)}`,
      `${this.planId}/objects2/${sha1.slice(0, 2)}/${sha1.slice(2, 4)}/${sha1.slice(4)}`,
    ];
    for (const objectName of candidates) {
      try {
        return await this.provider.readObject(this.bucket, objectName);
      } catch (error) {
        if (!(error instanceof CloudProviderError) || error.status !== 404) throw error;
      }
    }
    throw new ArchiveFormatError("missing_archive_object", `Arq 5 ${description} object ${sha1} was not found in packs or loose-object storage`);
  }

  #assertBlobIdentifier(bytes: Uint8Array, expected: string, description: string): void {
    const salt = this.keySet.blobIdSalt ?? Buffer.from(this.planId, "utf8");
    const actual = createHash("sha1").update(salt).update(bytes).digest("hex");
    if (actual !== expected.toLowerCase()) {
      throw new ArchiveFormatError(
        "blob_integrity_failed",
        `Arq 5 ${description} object ${expected} failed its salted SHA-1 integrity check`,
      );
    }
  }

  #reportUnlockProgress(event: Arq5PackSetProgressEvent): void {
    if (event.type === "indexes_discovered") this.#unlockProgress.totalPackIndexes += event.count;
    else if (event.type === "index_indexed") this.#unlockProgress.indexedPackIndexes += 1;
    else if (event.type === "pack_cache_miss") this.#unlockProgress.packCacheMisses += 1;
    else this.#unlockProgress.downloadedPacks += 1;
    if (this.#publishUnlockProgress) this.#emitUnlockProgress();
  }

  #emitUnlockProgress(): void {
    this.onUnlockProgress?.({ ...this.#unlockProgress });
  }

  #registerNode(folderId: string, name: string, node: Arq5Node, complete: boolean): ArchiveEntrySummary {
    const token = randomUUID();
    this.#nodes.set(token, { folderId, name, node, complete });
    return this.#entrySummary(token, name, node);
  }

  #registeredNode(token: string): RegisteredNode {
    const registered = this.#nodes.get(token);
    if (!registered) throw new ArchiveFormatError("missing_archive_node", "The selected Arq 5 node is no longer in this session");
    return registered;
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new ArchiveFormatError("missing_archive_node", "This archive session has been locked");
    }
  }

  #entrySummary(token: string, name: string, node: Arq5Node): ArchiveEntrySummary {
    const fileType = node.mode & 0o170000;
    return {
      token,
      name,
      kind: node.isTree ? "folder" : fileType === 0o120000 ? "symlink" : "file",
      size: safeNumber(node.uncompressedSize),
      modifiedAt: timestamp(node.modifiedSeconds, node.modifiedNanoseconds),
      mode: node.mode,
      containedFiles: 0,
    };
  }
}

function decompress(bytes: Uint8Array, compression: 0 | 1 | 2, description: string): Uint8Array {
  if (compression === 0) return bytes;
  if (compression === 1) {
    try {
      return Bun.gunzipSync(Uint8Array.from(bytes));
    } catch {
      throw new ArchiveFormatError("invalid_compressed_data", `An Arq 5 gzip ${description} blob could not be decompressed`);
    }
  }
  return inflateArqLz4(bytes);
}

async function listAll(provider: CloudStorageProvider, bucket: CloudBucket, prefix: string): Promise<CloudObject[]> {
  const objects: CloudObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await provider.listObjects(bucket, { prefix, cursor, limit: 10_000 });
    objects.push(...page.objects);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return objects;
}

function plistString(xml: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<key>\\s*${escaped}\\s*<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>`, "i").exec(xml);
  return match?.[1] ? decodeXml(match[1]).trim() || null : null;
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function lastPathComponent(path: string | null): string | null {
  return path?.replace(/\/+$/, "").split("/").at(-1) || null;
}

function safeNumber(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function safeBigIntNumber(value: bigint, label: string): number {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveFormatError("invalid_date", `An Arq 5 ${label} is out of range`);
  }
  return Number(value);
}

function timestamp(seconds: bigint, nanoseconds: bigint): string {
  const milliseconds = seconds * 1_000n + nanoseconds / 1_000_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER) || milliseconds < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new ArchiveFormatError("invalid_date", "An Arq 5 node has an out-of-range modification time");
  }
  const date = new Date(Number(milliseconds));
  if (Number.isNaN(date.getTime())) throw new ArchiveFormatError("invalid_date", "An Arq 5 node has an invalid modification time");
  return date.toISOString();
}

function startsWith(value: Uint8Array, prefix: Uint8Array): boolean {
  return value.byteLength >= prefix.byteLength && prefix.every((byte, index) => value[index] === byte);
}

class AsyncLimiter {
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(readonly concurrency: number) {}

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.#active < this.concurrency) this.#active += 1;
    else await new Promise<void>(resolve => this.#waiting.push(resolve));
    try {
      return await action();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active -= 1;
    }
  }
}
