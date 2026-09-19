import { createDecipheriv, createHmac, pbkdf2, timingSafeEqual } from "node:crypto";
import { decryptLegacyObject } from "../common/crypto";
import { ArchiveFormatError } from "../common/errors";

const HEADER = Buffer.from("ENCRYPTIONV2", "ascii");
const SALT_LENGTH = 8;
const HMAC_LENGTH = 32;
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const DERIVATION_ROUNDS = 200_000;

export type Arq5KeySet = {
  version: 2 | 3;
  encryptionKey: Uint8Array;
  hmacKey: Uint8Array;
  blobIdSalt: Uint8Array | null;
  destroy(): void;
};

export async function unlockArq5KeySet(
  encrypted: Uint8Array,
  password: string,
  version: 2 | 3,
): Promise<Arq5KeySet> {
  const saltOffset = HEADER.length;
  const hmacOffset = saltOffset + SALT_LENGTH;
  const ivOffset = hmacOffset + HMAC_LENGTH;
  const ciphertextOffset = ivOffset + IV_LENGTH;
  if (encrypted.byteLength <= ciphertextOffset || !startsWith(encrypted, HEADER)) {
    throw new ArchiveFormatError("invalid_key_set", `The Arq ${version} encryption file has an invalid header or length`);
  }

  const passwordBytes = Buffer.from(password, "utf8");
  let derived: Buffer | null = null;
  let plaintext: Buffer | null = null;
  const keys: Uint8Array[] = [];
  let valid = false;
  try {
    derived = await deriveKey(passwordBytes, encrypted.subarray(saltOffset, hmacOffset));
    const expectedHmac = createHmac("sha256", derived.subarray(KEY_LENGTH))
      .update(encrypted.subarray(ivOffset))
      .digest();
    if (!safeEqual(expectedHmac, encrypted.subarray(hmacOffset, ivOffset))) {
      throw new ArchiveFormatError("incorrect_password", "The Encryption Password is incorrect");
    }

    try {
      plaintext = decryptAesCbc(
        encrypted.subarray(ciphertextOffset),
        derived.subarray(0, KEY_LENGTH),
        encrypted.subarray(ivOffset, ciphertextOffset),
      );
    } catch {
      throw new ArchiveFormatError("invalid_key_set", `The Arq ${version} encryption keys could not be decrypted`);
    }

    const expectedLength = version === 3 ? KEY_LENGTH * 3 : KEY_LENGTH * 2;
    if (plaintext.byteLength !== expectedLength) {
      throw new ArchiveFormatError("invalid_key_set", `The Arq ${version} encryption file has an unexpected key payload`);
    }
    keys.push(
      Uint8Array.from(plaintext.subarray(0, KEY_LENGTH)),
      Uint8Array.from(plaintext.subarray(KEY_LENGTH, KEY_LENGTH * 2)),
    );
    if (version === 3) keys.push(Uint8Array.from(plaintext.subarray(KEY_LENGTH * 2)));
    valid = true;
    const [encryptionKey, hmacKey] = keys as [Uint8Array, Uint8Array];
    const blobIdSalt = keys[2] ?? null;
    return {
      version,
      encryptionKey,
      hmacKey,
      blobIdSalt,
      destroy() {
        encryptionKey.fill(0);
        hmacKey.fill(0);
        blobIdSalt?.fill(0);
      },
    };
  } finally {
    passwordBytes.fill(0);
    derived?.fill(0);
    plaintext?.fill(0);
    if (!valid) keys.forEach(key => key.fill(0));
  }
}

export function decryptArq5Object(encrypted: Uint8Array, keySet: Arq5KeySet): Uint8Array {
  // The archived per-blob `stretched` bit selects between ObjectEncryptorV1
  // password derivations only. Arq keyset versions 2 and 3 use authenticated
  // ARQO objects, whose decryption is independent of that historical bit.
  return decryptLegacyObject(encrypted, keySet);
}

function deriveKey(password: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, DERIVATION_ROUNDS, KEY_LENGTH * 2, "sha1", (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function decryptAesCbc(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer {
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function startsWith(value: Uint8Array, prefix: Uint8Array): boolean {
  return value.byteLength >= prefix.byteLength && prefix.every((byte, index) => value[index] === byte);
}

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
