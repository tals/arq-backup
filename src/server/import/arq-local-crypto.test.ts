import { describe, expect, test } from "bun:test";
import { createCipheriv, createHmac, pbkdf2Sync } from "node:crypto";
import { openArqLocalKeySet } from "./arq-local-crypto";

const password = "PasswordCryptor";
const wrongNearbyConstant = "c551b59a904857c184ecb13a1d0093219139b5c5317d6e43249482ac9aa59b29";

describe("Arq local key envelope", () => {
  test("opens the structured v3 local key set and destroys it", () => {
    const fixture = makeLocalKeySet();
    const keys = openArqLocalKeySet(fixture);
    expect(keys.version).toBe(3);
    expect(keys.encryptionKey).toEqual(Uint8Array.from({ length: 32 }, () => 0x11));
    expect(keys.hmacKey).toEqual(Uint8Array.from({ length: 32 }, () => 0x22));
    expect(keys.blobIdSalt).toEqual(Uint8Array.from({ length: 32 }, () => 0x33));
    keys.destroy();
    expect(keys.encryptionKey.every(byte => byte === 0)).toBe(true);
  });

  test("rejects an unauthenticated envelope", () => {
    const fixture = makeLocalKeySet();
    fixture[40]! ^= 0xff;
    expect(() => openArqLocalKeySet(fixture)).toThrow("failed authentication");
  });

  test("does not confuse PasswordCryptor V2 with ArqAgent's nearby constant", () => {
    const fixture = makeLocalKeySet(wrongNearbyConstant);
    expect(() => openArqLocalKeySet(fixture)).toThrow("failed authentication");
  });
});

function makeLocalKeySet(encryptionPassword = password): Uint8Array {
  const data = (byte: number) => Buffer.concat([u64(32), Buffer.alloc(32, byte)]);
  const plaintext = Buffer.concat([u32(3), data(0x11), data(0x22), data(0x33)]);
  const salt = Buffer.from("12345678");
  const iv = Buffer.alloc(16, 0x44);
  const derived = pbkdf2Sync(encryptionPassword, salt, 200_000, 64, "sha256");
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
