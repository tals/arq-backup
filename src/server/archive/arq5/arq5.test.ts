import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash, createHmac, pbkdf2Sync } from "node:crypto";
import type { CloudBucket } from "../../../shared/contracts";
import { CloudProviderError, type CloudStorageProvider, type ListObjectOptions, type ObjectPage, type ReadObjectOptions } from "../../cloud/provider";
import { unlockArq5KeySet, type Arq5KeySet } from "./crypto";
import { parseArq5Commit, parseArq5Tree } from "./models";
import { Arq5PackSet, extractPackRecord, parseArq5PackIndex } from "./pack-set";
import { Arq5Repository } from "./repository";

describe("Arq 5 encryption file", () => {
  test("unlocks ENCRYPTIONV2 without persisting a blob-id salt", async () => {
    const encrypted = makeEncryptionFile("hunter2", 2);
    const keys = await unlockArq5KeySet(encrypted, "hunter2", 2);
    expect(keys.encryptionKey).toEqual(Uint8Array.from({ length: 32 }, () => 0x11));
    expect(keys.hmacKey).toEqual(Uint8Array.from({ length: 32 }, () => 0x22));
    expect(keys.blobIdSalt).toBeNull();
    keys.destroy();
    expect(keys.encryptionKey.every(byte => byte === 0)).toBe(true);
  });

  test("rejects an incorrect password", async () => {
    await expect(unlockArq5KeySet(makeEncryptionFile("right", 2), "wrong", 2)).rejects.toMatchObject({
      code: "incorrect_password",
    });
  });
});

describe("Arq 5 pack indexes", () => {
  test("reports the discovered index total and each completed index", async () => {
    const firstSha1 = "1111111111111111111111111111111111111111";
    const secondSha1 = "2222222222222222222222222222222222222222";
    const prefix = "plan/packsets/folder-trees/";
    const provider = new PackProvider(new Map([
      [`${prefix}first.index`, makePackIndex(firstSha1, 0n, 4n)],
      [`${prefix}second.index`, makePackIndex(secondSha1, 0n, 4n)],
    ]));
    const events: Array<{ type: string; count?: number }> = [];
    const packSet = new Arq5PackSet(provider, testBucket, prefix, null, true, event => events.push(event));

    await packSet.prepare();

    expect(events[0]).toEqual({ type: "indexes_discovered", count: 2 });
    expect(events.filter(event => event.type === "index_indexed")).toHaveLength(2);
  });

  test("indexes up to 16 pack indexes concurrently", async () => {
    const prefix = "plan/packsets/folder-trees/";
    const provider = new ConcurrencyTrackingPackProvider(new Map(
      Array.from({ length: 20 }, (_, index) => {
        const sha1 = index.toString(16).padStart(40, "0");
        return [`${prefix}${index}.index`, makePackIndex(sha1, 0n, 4n)];
      }),
    ));
    const packSet = new Arq5PackSet(provider, testBucket, prefix, null);

    await packSet.prepare();

    expect(provider.maximumActiveReads).toBe(16);
  });

  test("maps object ids to pack record byte ranges and extracts the record", () => {
    const sha1 = "5abc13ed65a3a63309d639f6512ae2ce7ec098bb";
    const index = makePackIndex(sha1, 16n, 8n);
    expect(parseArq5PackIndex(index, "computer/packsets/folder-trees/pack.pack").get(sha1)).toEqual({
      packObjectName: "computer/packsets/folder-trees/pack.pack",
      offset: 16,
      legacyCorrectedOffset: 16,
      dataLength: 8,
    });
    const object = Buffer.from("ARQOtest");
    const record = Buffer.concat([Buffer.of(0, 0), uint64(8n), object]);
    expect(extractPackRecord(record, 8)).toEqual(object);
  });

  test("reads a historical direct ARQO index offset from a blob packset", async () => {
    const sha1 = "5abc13ed65a3a63309d639f6512ae2ce7ec098bb";
    const object = Buffer.from("ARQOdirect-blob");
    const provider = new PackProvider(new Map([
      ["plan/packsets/folder-blobs/legacy.index", makePackIndex(sha1, 0n, BigInt(object.byteLength))],
      ["plan/packsets/folder-blobs/legacy.pack", object],
    ]));
    const packSet = new Arq5PackSet(provider, testBucket, "plan/packsets/folder-blobs/", null, false);

    expect(await packSet.readObject(sha1)).toEqual(object);
  });

  test("corrects later offsets from Arq 4.5.3 regenerated pack indexes in memory", async () => {
    const firstSha1 = "1111111111111111111111111111111111111111";
    const secondSha1 = "2222222222222222222222222222222222222222";
    const first = Buffer.from("ARQOfirst");
    const second = Buffer.from("ARQOsecond");
    const header = Buffer.alloc(16);
    header.write("PACK", 0, "ascii");
    header.writeUInt32BE(2, 4);
    header.writeBigUInt64BE(2n, 8);
    const record = (bytes: Uint8Array) => Buffer.concat([Buffer.of(0, 0), uint64(BigInt(bytes.byteLength)), bytes]);
    const pack = Buffer.concat([header, record(first), record(second)]);
    const badSecondOffset = 16 + first.byteLength;
    const provider = new PackProvider(new Map([
      ["plan/packsets/folder-blobs/legacy.index", makePackIndexEntries([
        { sha1: firstSha1, offset: 16n, length: BigInt(first.byteLength) },
        { sha1: secondSha1, offset: BigInt(badSecondOffset), length: BigInt(second.byteLength) },
      ])],
      ["plan/packsets/folder-blobs/legacy.pack", pack],
    ]));
    const packSet = new Arq5PackSet(provider, testBucket, "plan/packsets/folder-blobs/", null, false);

    expect(await packSet.readObject(secondSha1)).toEqual(second);
  });
});

describe("Arq 5 metadata models", () => {
  test("parses a current commit and tree node", () => {
    const treeSha = "1234567890123456789012345678901234567890";
    const commit = parseArq5Commit(Buffer.concat([
      Buffer.from("CommitV012"),
      nullableString("tal"),
      nullableString(null),
      uint64(0n),
      nullableString(treeSha),
      Buffer.of(1),
      int32(2),
      nullableString("file://EXAMPLE-PC/C:/Users/example"),
      date(1_470_000_000_000n),
      uint64(0n),
      Buffer.of(0, 1),
      data(Buffer.from("<plist/>")),
      nullableString("5.0"),
    ]));
    expect(commit.tree).toMatchObject({ sha1: treeSha, stretched: true, compression: 2 });
    expect(commit.complete).toBe(true);

    const childSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const tree = parseArq5Tree(currentTree(childSha));
    expect(tree.children.get("Documents")).toMatchObject({ isTree: true, mode: 0o040755, uncompressedSize: 42n });
    expect(tree.children.get("Documents")?.dataBlobKeys[0]).toMatchObject({ sha1: childSha, compression: 2 });
  });

  test("rejects an authenticated commit stored under a different salted content identifier", async () => {
    const folderId = "11111111-2222-3333-4444-555555555555";
    const wrongId = "0".repeat(40);
    const keys = fakeArq5KeySet();
    const commit = currentCommit("1".repeat(40));
    const provider = new PackProvider(new Map([
      [`plan/buckets/${folderId}`, Buffer.from(`<plist><dict><key>BucketUUID</key><string>${folderId}</string><key>BucketName</key><string>Legacy</string></dict></plist>`)],
      [`plan/bucketdata/${folderId}/refs/heads/master`, Buffer.from(`${wrongId}Y`)],
      [`plan/objects/${wrongId}`, encryptArqObject(commit, keys)],
    ]));
    const repository = new Arq5Repository(provider, testBucket, "plan", keys);

    await expect(repository.listBackupFolders()).rejects.toMatchObject({ code: "blob_integrity_failed" });
    repository.destroy();
  });

  test("deduplicates concurrent tree reads so callers receive the same node tokens", async () => {
    const folderId = "11111111-2222-3333-4444-555555555555";
    const keys = fakeArq5KeySet();
    const tree = currentTree("a".repeat(40));
    const treeSha = arq5Identifier("plan", tree);
    const commit = currentCommit(treeSha);
    const commitSha = arq5Identifier("plan", commit);
    const provider = new PackProvider(new Map([
      [`plan/buckets/${folderId}`, Buffer.from(`<plist><dict><key>BucketUUID</key><string>${folderId}</string><key>BucketName</key><string>Legacy</string></dict></plist>`)],
      [`plan/bucketdata/${folderId}/refs/heads/master`, Buffer.from(commitSha)],
      [`plan/objects/${commitSha}`, encryptArqObject(commit, keys)],
      [`plan/objects/${treeSha}`, encryptArqObject(lz4Literal(tree), keys)],
    ]));
    const repository = new Arq5Repository(provider, testBucket, "plan", keys);
    const folders = await repository.listBackupFolders();
    const rootToken = folders[0]!.latestRecord!.root.token;

    const [left, right] = await Promise.all([
      repository.listChildren(rootToken),
      repository.listChildren(rootToken),
    ]);

    expect(left[0]?.token).toBe(right[0]?.token);
    expect(provider.reads.filter(name => name === `plan/objects/${treeSha}`)).toHaveLength(1);
    repository.destroy();
  });

  test("does not publish child tokens after the repository is destroyed mid-read", async () => {
    const folderId = "11111111-2222-3333-4444-555555555555";
    const keys = fakeArq5KeySet();
    const tree = currentTree("a".repeat(40));
    const treeSha = arq5Identifier("plan", tree);
    const commit = currentCommit(treeSha);
    const commitSha = arq5Identifier("plan", commit);
    const treeObjectName = `plan/objects/${treeSha}`;
    const provider = new BlockingPackProvider(new Map([
      [`plan/buckets/${folderId}`, Buffer.from(`<plist><dict><key>BucketUUID</key><string>${folderId}</string><key>BucketName</key><string>Legacy</string></dict></plist>`)],
      [`plan/bucketdata/${folderId}/refs/heads/master`, Buffer.from(commitSha)],
      [`plan/objects/${commitSha}`, encryptArqObject(commit, keys)],
      [treeObjectName, encryptArqObject(lz4Literal(tree), keys)],
    ]), treeObjectName);
    const repository = new Arq5Repository(provider, testBucket, "plan", keys);
    const folders = await repository.listBackupFolders();

    const listing = repository.listChildren(folders[0]!.latestRecord!.root.token);
    await provider.started;
    repository.destroy();
    provider.release();

    await expect(listing).rejects.toMatchObject({ code: "missing_archive_node" });
    await expect(repository.listChildren(folders[0]!.latestRecord!.root.token))
      .rejects.toMatchObject({ code: "missing_archive_node" });
  });
});

const testBucket: CloudBucket = {
  connectionId: 1,
  connectionLabel: "test",
  id: "bucket",
  name: "bucket",
};

class PackProvider implements CloudStorageProvider {
  readonly connectionId = testBucket.connectionId;
  readonly connectionLabel = testBucket.connectionLabel;
  readonly kind = "b2" as const;
  readonly reads: string[] = [];

  constructor(readonly objects: Map<string, Uint8Array>) {}

  async listBuckets(): Promise<CloudBucket[]> {
    return [testBucket];
  }

  async listObjects(_bucket: CloudBucket, options?: ListObjectOptions): Promise<ObjectPage> {
    const prefix = options?.prefix ?? "";
    return {
      objects: [...this.objects.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, bytes]) => ({ id: name, name, kind: "file" as const, size: bytes.byteLength, uploadedAt: null })),
      nextCursor: null,
    };
  }

  async readObject(_bucket: CloudBucket, objectName: string, options?: ReadObjectOptions): Promise<Uint8Array> {
    this.reads.push(objectName);
    const bytes = this.objects.get(objectName);
    if (!bytes) throw new CloudProviderError("not_found", `missing fake object ${objectName}`, 404);
    const range = options?.range;
    if (!range) return Uint8Array.from(bytes);
    return Uint8Array.from(bytes.subarray(range.start, (range.endInclusive ?? bytes.byteLength - 1) + 1));
  }
}

class BlockingPackProvider extends PackProvider {
  readonly started: Promise<void>;
  readonly #barrier: Promise<void>;
  #reportStarted!: () => void;
  #release!: () => void;
  #blocked = false;

  constructor(objects: Map<string, Uint8Array>, readonly blockedName: string) {
    super(objects);
    this.started = new Promise<void>(resolve => this.#reportStarted = resolve);
    this.#barrier = new Promise<void>(resolve => this.#release = resolve);
  }

  release(): void {
    this.#release();
  }

  override async readObject(bucket: CloudBucket, objectName: string, options?: ReadObjectOptions): Promise<Uint8Array> {
    if (objectName === this.blockedName && !this.#blocked) {
      this.#blocked = true;
      this.#reportStarted();
      await this.#barrier;
    }
    return super.readObject(bucket, objectName, options);
  }
}

class ConcurrencyTrackingPackProvider extends PackProvider {
  activeReads = 0;
  maximumActiveReads = 0;

  override async readObject(bucket: CloudBucket, objectName: string, options?: ReadObjectOptions): Promise<Uint8Array> {
    this.activeReads += 1;
    this.maximumActiveReads = Math.max(this.maximumActiveReads, this.activeReads);
    await Bun.sleep(5);
    try {
      return await super.readObject(bucket, objectName, options);
    } finally {
      this.activeReads -= 1;
    }
  }
}

function makeEncryptionFile(password: string, version: 2 | 3): Uint8Array {
  const salt = Buffer.from("12345678");
  const iv = Buffer.alloc(16, 0x44);
  const derived = pbkdf2Sync(password, salt, 200_000, 64, "sha1");
  const plaintext = Buffer.concat([
    Buffer.alloc(32, 0x11),
    Buffer.alloc(32, 0x22),
    ...(version === 3 ? [Buffer.alloc(32, 0x33)] : []),
  ]);
  const ciphertext = encrypt(plaintext, derived.subarray(0, 32), iv);
  const authenticated = Buffer.concat([iv, ciphertext]);
  const hmac = createHmac("sha256", derived.subarray(32)).update(authenticated).digest();
  derived.fill(0);
  return Buffer.concat([Buffer.from("ENCRYPTIONV2"), salt, hmac, authenticated]);
}

function currentCommit(treeSha: string): Buffer {
  return Buffer.concat([
    Buffer.from("CommitV012"),
    nullableString("tal"),
    nullableString(null),
    uint64(0n),
    nullableString(treeSha),
    Buffer.of(1),
    int32(2),
    nullableString("file://EXAMPLE-PC/C:/Users/example"),
    date(1_470_000_000_000n),
    uint64(0n),
    Buffer.of(0, 1),
    data(Buffer.from("<plist/>")),
    nullableString("5.0"),
  ]);
}

function currentTree(childSha: string): Buffer {
  return Buffer.concat([
    Buffer.from("TreeV019"),
    int32(0), int32(0),
    blobKey(null, 19), uint64(0n), blobKey(null, 19),
    int32(0), int32(0), int32(0o040755),
    int64(0n), int64(0n), int64(0n), int32(0), int32(0),
    int32(0), int32(0), uint32(1), int32(0), int64(0n), int64(0n), int64(0n), uint32(0),
    int64(0n), int64(0n),
    uint32(0),
    uint32(1), nullableString("Documents"),
    Buffer.of(1, 0),
    int32(2), int32(0), int32(0),
    int32(1), blobKey(childSha, 19), uint64(42n),
    blobKey(null, 19), uint64(0n), blobKey(null, 19),
    int32(501), int32(20), int32(0o040755), int64(1_470_000_000n), int64(123n),
    int64(0n), int32(0), int32(0), nullableString(null), nullableString(null), Buffer.of(0),
    int32(0), int32(0), uint32(1), int32(0), int64(0n), int64(0n), int64(0n), int64(0n), int64(0n), uint32(0),
  ]);
}

function arq5Identifier(planId: string, bytes: Uint8Array): string {
  return createHash("sha1").update(planId, "utf8").update(bytes).digest("hex");
}

function lz4Literal(bytes: Uint8Array): Uint8Array {
  const header = uint32(bytes.byteLength);
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

function fakeArq5KeySet(): Arq5KeySet {
  const encryptionKey = new Uint8Array(32);
  const hmacKey = new Uint8Array(32);
  return {
    version: 2,
    encryptionKey,
    hmacKey,
    blobIdSalt: null,
    destroy() {
      encryptionKey.fill(0);
      hmacKey.fill(0);
    },
  };
}

function encryptArqObject(plaintext: Uint8Array, keys: Arq5KeySet): Uint8Array {
  const dataIv = Buffer.alloc(16, 0x11);
  const dataKey = Buffer.alloc(32, 0x22);
  const masterIv = Buffer.alloc(16, 0x33);
  const encryptedMetadata = encrypt(Buffer.concat([dataIv, dataKey]), keys.encryptionKey, masterIv);
  const ciphertext = encrypt(plaintext, dataKey, dataIv);
  const authenticated = Buffer.concat([masterIv, encryptedMetadata, ciphertext]);
  const hmac = createHmac("sha256", keys.hmacKey).update(authenticated).digest();
  return Buffer.concat([Buffer.from("ARQO"), hmac, authenticated]);
}

function makePackIndex(sha1: string, offset: bigint, length: bigint): Uint8Array {
  return makePackIndexEntries([{ sha1, offset, length }]);
}

function makePackIndexEntries(entries: Array<{ sha1: string; offset: bigint; length: bigint }>): Uint8Array {
  const header = Buffer.alloc(4 + 4 + 256 * 4);
  header.writeUInt32BE(0xff744f63, 0);
  header.writeUInt32BE(2, 4);
  for (let index = 0; index < 256; index += 1) {
    const count = entries.filter(entry => Number.parseInt(entry.sha1.slice(0, 2), 16) <= index).length;
    header.writeUInt32BE(count, 8 + index * 4);
  }
  const body = Buffer.concat([
    header,
    ...entries.map(entry => Buffer.concat([
      uint64(entry.offset),
      uint64(entry.length),
      Buffer.from(entry.sha1, "hex"),
      Buffer.alloc(4),
    ])),
  ]);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

function blobKey(sha1: string | null, version: number): Buffer {
  return Buffer.concat([
    nullableString(sha1),
    ...(version >= 14 ? [Buffer.of(sha1 ? 1 : 0)] : []),
    ...(version >= 17 ? [uint32(1), nullableString(null), uint64(0n), date(null)] : []),
  ]);
}

function nullableString(value: string | null): Buffer {
  if (value === null) return Buffer.of(0);
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.of(1), uint64(BigInt(bytes.length)), bytes]);
}

function data(value: Uint8Array): Buffer {
  return Buffer.concat([uint64(BigInt(value.byteLength)), value]);
}

function date(value: bigint | null): Buffer {
  return value === null ? Buffer.of(0) : Buffer.concat([Buffer.of(1), int64(value)]);
}

function uint32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function int32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeInt32BE(value);
  return result;
}

function uint64(value: bigint): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(value);
  return result;
}

function int64(value: bigint): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigInt64BE(value);
  return result;
}

function encrypt(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer {
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
