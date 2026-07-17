import { describe, expect, test } from "bun:test";
import { createCipheriv, createHmac, pbkdf2Sync } from "node:crypto";
import { BinaryReader } from "./binary-reader";
import { decryptLegacyObject, unlockLegacyKeySet } from "./crypto";
import { ArchiveFormatError } from "./errors";
import { inflateArqLz4 } from "./lz4";

describe("Arq LZ4 blocks", () => {
  test("inflates a literal-only block", () => {
    const compressed = Uint8Array.of(0, 0, 0, 5, 0x50, ...Buffer.from("hello"));
    expect(new TextDecoder().decode(inflateArqLz4(compressed))).toBe("hello");
  });

  test("inflates overlapping matches", () => {
    const compressed = Uint8Array.of(0, 0, 0, 9, 0x32, ...Buffer.from("abc"), 3, 0);
    expect(new TextDecoder().decode(inflateArqLz4(compressed))).toBe("abcabcabc");
  });

  test("rejects output-size mismatches", () => {
    expect(() => inflateArqLz4(Uint8Array.of(0, 0, 0, 6, 0x50, ...Buffer.from("hello")))).toThrow(
      ArchiveFormatError,
    );
  });

  test("rejects an allocation larger than the per-blob safety limit", () => {
    const input = Buffer.alloc(5);
    input.writeUInt32BE(512 * 1024 * 1024 + 1, 0);
    expect(() => inflateArqLz4(input)).toThrow("more than 512 MiB");
  });
});

describe("archive binary reader", () => {
  test("reads big-endian numbers and nullable strings", () => {
    const bytes = Buffer.concat([
      Buffer.from([1]),
      Buffer.from([0x01, 0x02, 0x03, 0x04]),
      Buffer.from([1]),
      Buffer.from("0000000000000003", "hex"),
      Buffer.from("arq"),
    ]);
    const reader = new BinaryReader(bytes, "test");
    expect(reader.readBoolean()).toBe(true);
    expect(reader.readUint32()).toBe(0x01020304);
    expect(reader.readString("value")).toBe("arq");
    expect(reader.remaining).toBe(0);
  });
});

describe("legacy authenticated encryption", () => {
  test("unlocks a key set and decrypts an authenticated object", async () => {
    const password = "correct horse battery staple";
    const fixture = makeFixture(password);
    const keySet = await unlockLegacyKeySet(fixture.encryptedKeySet, password);
    const compressed = decryptLegacyObject(fixture.encryptedObject, keySet);
    expect(inflateArqLz4(compressed)).toEqual(fixture.plaintext);
    keySet.destroy();
    expect(keySet.encryptionKey.every(byte => byte === 0)).toBe(true);
  });

  test("rejects an incorrect password", async () => {
    const fixture = makeFixture("right password");
    expect(unlockLegacyKeySet(fixture.encryptedKeySet, "wrong password")).rejects.toMatchObject({
      code: "incorrect_password",
    });
  });
});

function makeFixture(password: string): {
  encryptedKeySet: Uint8Array;
  encryptedObject: Uint8Array;
  plaintext: Uint8Array;
} {
  const masterEncryptionKey = Buffer.alloc(32, 0x11);
  const masterHmacKey = Buffer.alloc(32, 0x22);
  const blobIdSalt = Buffer.alloc(32, 0x33);
  const salt = Buffer.from("12345678");
  const keySetIv = Buffer.alloc(16, 0x44);
  const derived = pbkdf2Sync(password, salt, 200_000, 64, "sha1");
  const encryptedMasterKeys = encryptAesCbc(
    Buffer.concat([masterEncryptionKey, masterHmacKey, blobIdSalt]),
    derived.subarray(0, 32),
    keySetIv,
  );
  const keySetAuthenticatedData = Buffer.concat([keySetIv, encryptedMasterKeys]);
  const keySetHmac = createHmac("sha256", derived.subarray(32)).update(keySetAuthenticatedData).digest();
  const encryptedKeySet = Buffer.concat([
    Buffer.from("ARQ_ENCRYPTED_MASTER_KEYS"),
    salt,
    keySetHmac,
    keySetAuthenticatedData,
  ]);

  const plaintext = Buffer.from("abcabcabc");
  const compressed = Buffer.from([0, 0, 0, 9, 0x32, ...Buffer.from("abc"), 3, 0]);
  const dataIv = Buffer.alloc(16, 0x55);
  const dataKey = Buffer.alloc(32, 0x66);
  const masterIv = Buffer.alloc(16, 0x77);
  const encryptedMetadata = encryptAesCbc(Buffer.concat([dataIv, dataKey]), masterEncryptionKey, masterIv);
  const ciphertext = encryptAesCbc(compressed, dataKey, dataIv);
  const objectAuthenticatedData = Buffer.concat([masterIv, encryptedMetadata, ciphertext]);
  const objectHmac = createHmac("sha256", masterHmacKey).update(objectAuthenticatedData).digest();
  const encryptedObject = Buffer.concat([Buffer.from("ARQO"), objectHmac, objectAuthenticatedData]);

  derived.fill(0);
  return { encryptedKeySet, encryptedObject, plaintext };
}

function encryptAesCbc(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer {
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
