import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash, createHmac } from "node:crypto";
import type { CloudBucket } from "../../../shared/contracts";
import type { CloudStorageProvider, ListObjectOptions, ObjectPage, ReadObjectOptions } from "../../cloud/provider";
import type { Arq7KeySet } from "./crypto";
import { ModernArqRepository } from "../modern/repository";
import { parseBackupRecord, parseBlobLocation, type Arq7BlobLocation, type Arq7Node } from "./models";
import { Arq7Repository } from "./repository";

const bucket: CloudBucket = { connectionId: 1, connectionLabel: "test", id: "bucket", name: "bucket" };

describe("Arq 7 blob reading", () => {
  test("falls back from a newer incomplete record to the newest complete record", async () => {
    const provider = new FakeProvider();
    const keys = fakeKeySet();
    const folderPrefix = "plan/backupfolders/folder";
    provider.objects.set(
      `${folderPrefix}/backupfolder.json`,
      Buffer.from(JSON.stringify({ name: "Mac", localPath: "/" })),
    );
    provider.objects.set(`${folderPrefix}/backuprecords/00170/0000002.backuprecord`, encryptObject(
      lz4Literal(backupRecord(false, 2)),
      keys,
    ));
    provider.objects.set(`${folderPrefix}/backuprecords/00170/0000003.backuprecord`, encryptObject(
      lz4Literal(importedBackupRecord(3)),
      keys,
    ));
    provider.objects.set(
      `${folderPrefix}/backuprecords/00170/0000001.backuprecord`,
      lz4Literal(backupRecord(true, 1)),
    );
    const repository = new Arq7Repository(provider, bucket, "plan", keys);

    const folders = await repository.listBackupFolders();

    expect(folders[0]?.latestRecord).toMatchObject({
      id: `${folderPrefix}/backuprecords/00170/0000001.backuprecord`,
      complete: true,
    });
    repository.destroy();
  });

  test("accepts fractional backup creation dates", () => {
    const creationDate = 1_712_345_678.25;
    const record = parseBackupRecord(Buffer.from(JSON.stringify({
      backupFolderUUID: "folder",
      backupPlanUUID: "plan",
      creationDate,
      isComplete: true,
      localPath: "/Users/example",
      volumeName: null,
      version: 100,
      node: {
        isTree: true,
        treeBlobLoc: null,
        dataBlobLocs: [],
        itemSize: 0,
        containedFilesCount: 0,
        modificationTime_sec: -1,
        modificationTime_nsec: 0,
        mac_st_mode: 0o040755,
      },
    })));

    expect(record.creationDate).toBe(creationDate);
    expect(record.node?.modificationTimeSeconds).toBe(-1);
    expect(record.isImportedFromArq5).toBeFalse();
  });

  test("recognizes an imported Arq 5-shaped record without requiring a native node", () => {
    const record = parseBackupRecord(importedBackupRecord(3));

    expect(record).toMatchObject({ version: 12, isImportedFromArq5: true, node: null });
  });

  test("defaults an omitted canonical blob relative path to empty", () => {
    expect(parseBlobLocation({
      blobIdentifier: "a".repeat(64),
      isPacked: false,
      offset: 0,
      length: 0,
      stretchEncryptionKey: false,
      compressionType: 0,
    }).relativePath).toBe("");
  });

  test("ranges packed blobs but reads loose objects in full and leaves raw plaintext alone", async () => {
    const provider = new FakeProvider();
    const keys = fakeKeySet();
    const repository = new Arq7Repository(provider, bucket, "plan", keys);
    const packed = Buffer.from("payload");
    const loose = Buffer.from("loose plaintext");
    provider.objects.set("plan/backupconfig.json", Buffer.from(JSON.stringify({ blobIdentifierType: 2 })));
    provider.objects.set("plan/packs/example.pack", packed);
    provider.objects.set("plan/objects/loose", loose);

    expect(await repository.readBlob(location("packs/example.pack", true, 2, 7, saltedIdentifier(keys, packed)))).toEqual(packed);
    expect(await repository.readBlob(location("objects/loose", false, 99, 1, saltedIdentifier(keys, loose)))).toEqual(loose);
    expect(provider.reads).toEqual([
      { name: "plan/backupconfig.json", options: undefined },
      { name: "plan/packs/example.pack", options: { range: { start: 2, endInclusive: 8 } } },
      { name: "plan/objects/loose", options: undefined },
    ]);
    repository.destroy();
  });

  test("rejects same-length plaintext that does not match the salted blob identifier", async () => {
    const provider = new FakeProvider();
    const keys = fakeKeySet();
    const expected = Buffer.from("payload");
    provider.objects.set("plan/backupconfig.json", Buffer.from(JSON.stringify({ blobIdentifierType: 2 })));
    provider.objects.set("plan/objects/swapped", Buffer.from("corrupt"));
    const repository = new Arq7Repository(provider, bucket, "plan", keys);

    await expect(repository.readBlob(location(
      "objects/swapped",
      false,
      0,
      7,
      saltedIdentifier(keys, expected),
    ))).rejects.toMatchObject({ code: "blob_integrity_failed" });
    repository.destroy();
  });

  test("retries blob identifier configuration after a transient read failure", async () => {
    const provider = new FakeProvider();
    const keys = fakeKeySet();
    const bytes = Buffer.from("payload");
    provider.objects.set("plan/backupconfig.json", Buffer.from(JSON.stringify({ blobIdentifierType: 2 })));
    provider.objects.set("plan/objects/retry", bytes);
    provider.failOnce.add("plan/backupconfig.json");
    const repository = new Arq7Repository(provider, bucket, "plan", keys);
    const blob = location("objects/retry", false, 0, bytes.byteLength, saltedIdentifier(keys, bytes));

    await expect(repository.readBlob(blob)).rejects.toThrow("transient read failure");
    expect(await repository.readBlob(blob)).toEqual(bytes);
    expect(provider.reads.filter(read => read.name === "plan/backupconfig.json")).toHaveLength(2);
    repository.destroy();
  });

  test("does not publish child tokens after the repository is destroyed mid-read", async () => {
    let reportStarted!: () => void;
    let releaseRead!: () => void;
    const started = new Promise<void>(resolve => reportStarted = resolve);
    const barrier = new Promise<void>(resolve => releaseRead = resolve);
    const repository = new ControlledModernRepository(fakeKeySet(), reportStarted, barrier);
    const root = repository.registerFolder();

    const listing = repository.listChildren(root.token);
    await started;
    repository.destroy();
    releaseRead();

    await expect(listing).rejects.toMatchObject({ code: "missing_archive_node" });
    await expect(repository.listChildren(root.token)).rejects.toMatchObject({ code: "missing_archive_node" });
  });

  test("restores the complete dense byte stream of a sparse modern file", async () => {
    const provider = new FakeProvider();
    const keys = fakeKeySet();
    const bytes = Buffer.from([1, 0, 0, 0, 2]);
    provider.objects.set("plan/backupconfig.json", Buffer.from(JSON.stringify({ blobIdentifierType: 2 })));
    provider.objects.set("plan/objects/sparse", bytes);
    const repository = new TestModernRepository(provider, keys);
    const entry = repository.registerFile({
      isTree: false,
      treeBlobLoc: null,
      dataBlobLocs: [location("objects/sparse", false, 0, bytes.byteLength, saltedIdentifier(keys, bytes))],
      itemSize: bytes.byteLength,
      containedFilesCount: 1,
      modificationTimeSeconds: 0,
      modificationTimeNanoseconds: 0,
      mode: 0o100644,
      deleted: false,
      isSparse: true,
      sparseLogicalSize: bytes.byteLength,
    });

    expect(entry).toMatchObject({ name: "sparse.img", kind: "file", size: bytes.byteLength });
    const chunks: Uint8Array[] = [];
    for await (const chunk of repository.readData(entry.token)) chunks.push(Uint8Array.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    repository.destroy();
  });
});

class TestModernRepository extends ModernArqRepository {
  constructor(provider: CloudStorageProvider, keys: Arq7KeySet) {
    super(provider, bucket, "plan", keys, "arq7", "Arq 7");
  }

  async listBackupFolders() {
    return [];
  }

  registerFile(node: Arq7Node) {
    return this.registerRoot("folder", "sparse.img", node, true);
  }
}

class ControlledModernRepository extends ModernArqRepository {
  constructor(
    keys: Arq7KeySet,
    readonly reportStarted: () => void,
    readonly barrier: Promise<void>,
  ) {
    super(new FakeProvider(), bucket, "plan", keys, "arq7", "Arq 7");
  }

  async listBackupFolders() {
    return [];
  }

  registerFolder() {
    return this.registerRoot("folder", "root", {
      isTree: true,
      treeBlobLoc: location("objects/tree", false, 0, 1, "0".repeat(64)),
      dataBlobLocs: [],
      itemSize: 0,
      containedFilesCount: 0,
      modificationTimeSeconds: 0,
      modificationTimeNanoseconds: 0,
      mode: 0o040755,
      deleted: false,
      isSparse: false,
      sparseLogicalSize: 0,
    }, true);
  }

  override async readBlob(): Promise<Uint8Array> {
    this.reportStarted();
    await this.barrier;
    return Buffer.from("not parsed after lock");
  }
}

class FakeProvider implements CloudStorageProvider {
  readonly connectionId = 1;
  readonly connectionLabel = "test";
  readonly kind = "b2" as const;
  readonly objects = new Map<string, Uint8Array>();
  readonly reads: Array<{ name: string; options: ReadObjectOptions | undefined }> = [];
  readonly failOnce = new Set<string>();

  async listBuckets(): Promise<CloudBucket[]> {
    return [bucket];
  }

  async listObjects(_bucket: CloudBucket, _options?: ListObjectOptions): Promise<ObjectPage> {
    const options = _options ?? {};
    const prefix = options.prefix ?? "";
    if (options.delimiter === "/") {
      const folders = new Set<string>();
      for (const name of this.objects.keys()) {
        if (!name.startsWith(prefix)) continue;
        const remainder = name.slice(prefix.length);
        const slash = remainder.indexOf("/");
        if (slash >= 0) folders.add(`${prefix}${remainder.slice(0, slash + 1)}`);
      }
      return {
        objects: [...folders].map(name => ({ id: name, name, kind: "folder", size: 0, uploadedAt: null })),
        nextCursor: null,
      };
    }
    return {
      objects: [...this.objects.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, value]) => ({ id: name, name, kind: "file", size: value.byteLength, uploadedAt: null })),
      nextCursor: null,
    };
  }

  async readObject(_bucket: CloudBucket, name: string, options?: ReadObjectOptions): Promise<Uint8Array> {
    this.reads.push({ name, options });
    if (this.failOnce.delete(name)) throw new Error("transient read failure");
    const value = this.objects.get(name);
    if (!value) throw new Error(`missing object ${name}`);
    if (!options?.range) return Uint8Array.from(value);
    return Uint8Array.from(value.subarray(options.range.start - 2, options.range.endInclusive! - 1));
  }
}

function location(
  relativePath: string,
  isPacked: boolean,
  offset: number,
  length: number,
  blobIdentifier: string,
): Arq7BlobLocation {
  return {
    blobIdentifier,
    isPacked,
    isLargePack: false,
    relativePath,
    offset,
    length,
    stretchEncryptionKey: false,
    compressionType: 0,
  };
}

function saltedIdentifier(keys: Arq7KeySet, bytes: Uint8Array): string {
  return createHash("sha256").update(keys.blobIdSalt).update(bytes).digest("hex");
}

function fakeKeySet(): Arq7KeySet {
  const encryptionKey = new Uint8Array(32);
  const hmacKey = new Uint8Array(32);
  const blobIdSalt = new Uint8Array(32);
  return {
    version: 3,
    encryptionKey,
    hmacKey,
    blobIdSalt,
    destroy() {
      encryptionKey.fill(0);
      hmacKey.fill(0);
      blobIdSalt.fill(0);
    },
  };
}

function backupRecord(isComplete: boolean, creationDate: number): Uint8Array {
  return Buffer.from(JSON.stringify({
    version: 100,
    backupFolderUUID: "folder",
    backupPlanUUID: "plan",
    creationDate,
    isComplete,
    localPath: "/",
    volumeName: "Mac",
    node: {
      isTree: true,
      treeBlobLoc: null,
      dataBlobLocs: [],
      itemSize: 0,
      containedFilesCount: 0,
      modificationTime_sec: 0,
      modificationTime_nsec: 0,
      mac_st_mode: 0o040755,
    },
  }));
}

function importedBackupRecord(creationDate: number): Uint8Array {
  return Buffer.from(JSON.stringify({
    version: 12,
    backupFolderUUID: "folder",
    backupPlanUUID: "plan",
    creationDate,
    isComplete: true,
    localPath: "/",
    volumeName: "Mac",
    arq5TreeBlobKey: { sha1: "0123456789abcdef0123456789abcdef01234567" },
  }));
}

function encryptObject(plaintext: Uint8Array, keys: Arq7KeySet): Uint8Array {
  const dataIv = Buffer.alloc(16, 0x11);
  const dataKey = Buffer.alloc(32, 0x22);
  const masterIv = Buffer.alloc(16, 0x33);
  const encryptedMetadata = encryptAesCbc(Buffer.concat([dataIv, dataKey]), keys.encryptionKey, masterIv);
  const ciphertext = encryptAesCbc(plaintext, dataKey, dataIv);
  const authenticated = Buffer.concat([masterIv, encryptedMetadata, ciphertext]);
  const hmac = createHmac("sha256", keys.hmacKey).update(authenticated).digest();
  return Buffer.concat([Buffer.from("ARQO"), hmac, authenticated]);
}

function encryptAesCbc(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer {
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function lz4Literal(bytes: Uint8Array): Uint8Array {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.byteLength);
  if (bytes.byteLength < 15) return Buffer.concat([header, Buffer.of(bytes.byteLength << 4), bytes]);
  const extensions: number[] = [];
  let remaining = bytes.byteLength - 15;
  while (remaining >= 255) {
    extensions.push(255);
    remaining -= 255;
  }
  extensions.push(remaining);
  return Buffer.concat([header, Buffer.of(0xf0), Buffer.from(extensions), bytes]);
}
