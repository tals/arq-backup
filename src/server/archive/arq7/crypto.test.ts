import { describe, expect, test } from "bun:test";
import { createCipheriv, createHmac, pbkdf2Sync } from "node:crypto";
import { unlockArq7KeySet } from "./crypto";

describe("Arq 7 keyset", () => {
  test("unlocks a structured v3 keyset", async () => {
    const encrypted = makeKeySet("recovery password");
    const keys = await unlockArq7KeySet(encrypted, "recovery password");
    expect(keys.version).toBe(3);
    expect(keys.encryptionKey).toEqual(Uint8Array.from({ length: 32 }, () => 0x11));
    keys.destroy();
  });

  test("reports an incorrect password", async () => {
    const encrypted = makeKeySet("right");
    expect(unlockArq7KeySet(encrypted, "wrong")).rejects.toMatchObject({ code: "incorrect_password" });
  });
});

function makeKeySet(password: string): Uint8Array {
  const data = (byte: number) => Buffer.concat([u64(32), Buffer.alloc(32, byte)]);
  const plaintext = Buffer.concat([u32(3), data(0x11), data(0x22), data(0x33)]);
  const salt = Buffer.from("12345678");
  const iv = Buffer.alloc(16, 0x44);
  const derived = pbkdf2Sync(password, salt, 200_000, 64, "sha256");
  const cipher = createCipheriv("aes-256-cbc", derived.subarray(0, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const hmac = createHmac("sha256", derived.subarray(32)).update(Buffer.concat([iv, ciphertext])).digest();
  derived.fill(0);
  return Buffer.concat([Buffer.from("ARQ_ENCRYPTED_MASTER_KEYS"), salt, hmac, iv, ciphertext]);
}

function u32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function u64(value: number): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(BigInt(value));
  return result;
}
