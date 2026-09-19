import type { BackupFolderSummary, BackupRecordSummary, CloudBucket } from "../../../shared/contracts";
import type { CloudObject, CloudStorageProvider } from "../../cloud/provider";
import { ArchiveFormatError } from "../common/errors";
import { inflateArqLz4 } from "../common/lz4";
import { ModernArqRepository, startsWithArqo } from "../modern/repository";
import { decryptArq7Object, type Arq7KeySet } from "./crypto";
import { parseBackupRecord, type Arq7BackupRecord, type Arq7Node } from "./models";

type NativeArq7BackupRecord = Arq7BackupRecord & { node: Arq7Node };

export class Arq7Repository extends ModernArqRepository {
  constructor(
    provider: CloudStorageProvider,
    bucket: CloudBucket,
    planId: string,
    keySet: Arq7KeySet,
  ) {
    super(provider, bucket, planId, keySet, "arq7", "Arq 7");
  }

  async listBackupFolders(): Promise<BackupFolderSummary[]> {
    const prefix = `${this.planId}/backupfolders/`;
    const objects = await this.listAll({ prefix, delimiter: "/" });
    const folderIds = objects
      .filter(object => object.kind === "folder" && object.name.endsWith("/"))
      .map(object => object.name.slice(prefix.length, -1))
      .filter(Boolean);
    const folders = await Promise.all(folderIds.map(folderId => this.#openFolder(folderId)));
    return folders.sort((left, right) => left.name.localeCompare(right.name));
  }

  async #openFolder(folderId: string): Promise<BackupFolderSummary> {
    const metadata = await this.#readFolderMetadata(folderId);
    const selected = await this.#latestUsableRecord(folderId);
    if (!selected) {
      return { id: folderId, name: metadata.name ?? folderId, localPath: metadata.localPath, latestRecord: null };
    }
    const { object: recordObject, record } = selected;
    const name = metadata.name ?? (record.volumeName?.trim() || lastPathComponent(record.localPath) || folderId);
    const root = this.registerRoot(folderId, name, record.node, record.isComplete);
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
    const stored = await this.provider.readObject(this.bucket, objectName);
    const plaintext = startsWithArqo(stored) ? decryptArq7Object(stored, this.keySet) : stored;
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      const metadata = value as Record<string, unknown>;
      return {
        name: typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : null,
        localPath: typeof metadata.localPath === "string" ? metadata.localPath : null,
      };
    } catch {
      throw new ArchiveFormatError("invalid_backup_folder", "The Arq 7 backup folder metadata is not valid JSON");
    } finally {
      plaintext.fill(0);
    }
  }

  async #latestUsableRecord(
    folderId: string,
  ): Promise<{ object: CloudObject; record: NativeArq7BackupRecord } | null> {
    let newestIncomplete: { object: CloudObject; record: NativeArq7BackupRecord } | null = null;
    let sawImportedRecord = false;
    for (const object of await this.#recordObjects(folderId)) {
      const record = await this.#readRecord(object);
      if (record.backupFolderUUID !== folderId || record.backupPlanUUID !== this.planId) {
        throw new ArchiveFormatError("mismatched_backup_record", "An Arq 7 backup record belongs to a different plan or folder");
      }
      if (record.node === null) {
        sawImportedRecord ||= record.isImportedFromArq5;
        continue;
      }
      const nativeRecord: NativeArq7BackupRecord = { ...record, node: record.node };
      if (nativeRecord.isComplete) return { object, record: nativeRecord };
      newestIncomplete ??= { object, record: nativeRecord };
    }
    if (newestIncomplete) return newestIncomplete;
    if (sawImportedRecord) {
      throw new ArchiveFormatError(
        "unsupported_arq7_imported_record",
        "This Arq 7 backup folder only contains imported Arq 5 records; its native node tree is unavailable",
      );
    }
    return null;
  }

  async #recordObjects(folderId: string): Promise<CloudObject[]> {
    const prefix = `${this.planId}/backupfolders/${folderId}/backuprecords/`;
    const groups = (await this.listAll({ prefix, delimiter: "/" }))
      .filter(object => object.kind === "folder" && /^\d{5}\/$/.test(object.name.slice(prefix.length)))
      .sort((left, right) => right.name.localeCompare(left.name));
    const allRecords: CloudObject[] = [];
    for (const group of groups) {
      const records = (await this.listAll({ prefix: group.name }))
        .filter(object => object.kind === "file" && /^\d{7}\.backuprecord$/.test(object.name.slice(group.name.length)))
        .sort((left, right) => right.name.localeCompare(left.name));
      allRecords.push(...records);
    }
    return allRecords;
  }

  async #readRecord(object: CloudObject): Promise<Arq7BackupRecord> {
    const stored = await this.provider.readObject(this.bucket, object.name);
    const plaintext = startsWithArqo(stored) ? decryptArq7Object(stored, this.keySet) : stored;
    let inflated: Uint8Array | null = null;
    try {
      inflated = inflateArqLz4(plaintext);
      return parseBackupRecord(inflated);
    } finally {
      inflated?.fill(0);
      plaintext.fill(0);
    }
  }
}

function lastPathComponent(path: string): string | null {
  return path.replace(/\/+$/, "").split("/").at(-1) || null;
}
