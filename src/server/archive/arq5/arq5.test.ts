import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { unlockArq5KeySet } from "./crypto";
import { parseArq5Commit, parseArq5Tree } from "./models";
import { extractPackRecord, parseArq5PackIndex } from "./pack-set";

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
  test("maps object ids to pack record byte ranges and extracts the record", () => {
    const sha1 = "5abc13ed65a3a63309d639f6512ae2ce7ec098bb";
    const index = makePackIndex(sha1, 16n, 8n);
    expect(parseArq5PackIndex(index, "computer/packsets/folder-trees/pack.pack").get(sha1)).toEqual({
      packObjectName: "computer/packsets/folder-trees/pack.pack",
      offset: 16,
      dataLength: 8,
    });
    const object = Buffer.from("ARQOtest");
    const record = Buffer.concat([Buffer.of(0, 0), uint64(8n), object]);
    expect(extractPackRecord(record, 8)).toEqual(object);
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
    const tree = parseArq5Tree(Buffer.concat([
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
    ]));
    expect(tree.children.get("Documents")).toMatchObject({ isTree: true, mode: 0o040755, uncompressedSize: 42n });
    expect(tree.children.get("Documents")?.dataBlobKeys[0]).toMatchObject({ sha1: childSha, compression: 2 });
  });
});

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

function makePackIndex(sha1: string, offset: bigint, length: bigint): Uint8Array {
  const header = Buffer.alloc(4 + 4 + 256 * 4);
  header.writeUInt32BE(0xff744f63, 0);
  header.writeUInt32BE(2, 4);
  const firstByte = Number.parseInt(sha1.slice(0, 2), 16);
  for (let index = firstByte; index < 256; index += 1) header.writeUInt32BE(1, 8 + index * 4);
  const entry = Buffer.concat([uint64(offset), uint64(length), Buffer.from(sha1, "hex"), Buffer.alloc(4)]);
  const body = Buffer.concat([header, entry]);
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
