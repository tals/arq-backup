import type { BackupFolderSummary, BackupRecordSummary, CloudBucket } from "../../../shared/contracts";
import type { CloudObject, CloudStorageProvider } from "../../cloud/provider";
import { decryptArq7Object, type Arq7KeySet } from "../arq7/crypto";
import { ArchiveFormatError } from "../common/errors";
import { inflateArqLz4 } from "../common/lz4";
import { ModernArqRepository, startsWithArqo } from "../modern/repository";
import { parseArq6Snapshot, type Arq6Snapshot } from "./models";

export class Arq6Repository extends ModernArqRepository {
  constructor(
    provider: CloudStorageProvider,
    bucket: CloudBucket,
    planId: string,
    keySet: Arq7KeySet,
  ) {
    super(provider, bucket, planId, keySet, "arq6", "Arq 6");
  }

  async listBackupFolders(): Promise<BackupFolderSummary[]> {
    const snapshots = await this.#snapshotObjects();
    if (snapshots.length === 0) return [];

    let selected: { object: CloudObject; snapshot: Arq6Snapshot } | null = null;
    for (const object of snapshots) {
      const snapshot = await this.#readSnapshot(object);
      selected ??= { object, snapshot };
      if (snapshot.isComplete) {
        selected = { object, snapshot };
        break;
      }
    }
    if (!selected) return [];
    if (selected.snapshot.planUUID !== this.planId) {
      throw new ArchiveFormatError("mismatched_arq6_snapshot", "An experimental Arq 6 snapshot belongs to a different backup plan");
    }

    const nativeVolumes = selected.snapshot.volumes.filter(volume => !volume.isImportedFromArq5);
    if (selected.snapshot.isImportedFromArq5
      || (selected.snapshot.volumes.length > 0 && nativeVolumes.length === 0)
      || (nativeVolumes.length === 0 && selected.snapshot.skippedNodeLessVolumes > 0)) {
      throw new ArchiveFormatError(
        "unsupported_arq6_imported_snapshot",
        "This Arq 6 snapshot was imported from Arq 5; the experimental reader currently supports native Arq 6 snapshots only",
      );
    }

    const folders = nativeVolumes.map(volume => {
      const name = volume.name.trim() || volume.diskIdentifier;
      const root = this.registerRoot(volume.diskIdentifier, name, volume.node, selected.snapshot.isComplete);
      const latestRecord: BackupRecordSummary = {
        id: selected.object.name,
        createdAt: new Date(selected.snapshot.creationDate * 1_000).toISOString(),
        complete: selected.snapshot.isComplete,
        root,
      };
      return {
        id: volume.diskIdentifier,
        name,
        localPath: volume.mountPoint || null,
        latestRecord,
      } satisfies BackupFolderSummary;
    });
    return folders.sort((left, right) => left.name.localeCompare(right.name));
  }

  async #snapshotObjects(): Promise<CloudObject[]> {
    const prefix = `${this.planId}/snapshots/`;
    return (await this.listAll({ prefix }))
      .filter(object => object.kind === "file" && /^\d{5}\/\d{7}\.snapshot$/.test(object.name.slice(prefix.length)))
      .sort((left, right) => right.name.localeCompare(left.name));
  }

  async #readSnapshot(object: CloudObject): Promise<Arq6Snapshot> {
    const stored = await this.provider.readObject(this.bucket, object.name);
    const decrypted = startsWithArqo(stored) ? decryptArq7Object(stored, this.keySet) : stored;
    let inflated: Uint8Array | null = null;
    try {
      inflated = inflateArqLz4(decrypted);
      return parseArq6Snapshot(inflated);
    } finally {
      inflated?.fill(0);
      if (decrypted !== stored) decrypted.fill(0);
      stored.fill(0);
    }
  }
}
