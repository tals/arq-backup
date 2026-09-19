import { createDecipheriv, createHmac, pbkdf2, timingSafeEqual } from "node:crypto";
import { decryptLegacyObject } from "../common/crypto";
import { ArchiveFormatError } from "../common/errors";

const KEY_SET_HEADER = Buffer.from("ARQ_ENCRYPTED_MASTER_KEYS", "ascii");
const SALT_LENGTH = 8;
const SHA256_LENGTH = 32;
const AES_BLOCK_LENGTH = 16;
const AES_KEY_LENGTH = 32;
const KEY_DERIVATION_ROUNDS = 200_000;

export type Arq7KeySet = {
  version: 3;
  encryptionKey: Uint8Array;
  hmacKey: Uint8Array;
  blobIdSalt: Uint8Array;
  destroy(): void;
};

export async function unlockArq7KeySet(encrypted: Uint8Array, password: string): Promise<Arq7KeySet> {
  const saltOffset = KEY_SET_HEADER.length;
  const hmacOffset = saltOffset + SALT_LENGTH;
  const ivOffset = hmacOffset + SHA256_LENGTH;
  const ciphertextOffset = ivOffset + AES_BLOCK_LENGTH;
  if (encrypted.byteLength <= ciphertextOffset || !startsWith(encrypted, KEY_SET_HEADER)) {
    throw new ArchiveFormatError("invalid_key_set", "The Arq 7 encrypted keyset has an invalid header or length");
  }

  const passwordBytes = Buffer.from(password, "utf8");
  let derived: Buffer | null = null;
  let plaintext: Buffer | null = null;
  const parts: Uint8Array[] = [];
  let valid = false;
  try {
    derived = await deriveKey(passwordBytes, encrypted.subarray(saltOffset, hmacOffset));
    const expectedHmac = createHmac("sha256", derived.subarray(AES_KEY_LENGTH))
      .update(encrypted.subarray(ivOffset))
      .digest();
    if (!safeEqual(expectedHmac, encrypted.subarray(hmacOffset, ivOffset))) {
      throw new ArchiveFormatError("incorrect_password", "The Encryption Password is incorrect");
    }

    try {
      plaintext = decryptAesCbc(
        encrypted.subarray(ciphertextOffset),
        derived.subarray(0, AES_KEY_LENGTH),
        encrypted.subarray(ivOffset, ciphertextOffset),
      );
    } catch {
      throw new ArchiveFormatError("invalid_key_set", "The Arq 7 keyset payload could not be decrypted");
    }

    const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
    let offset = 0;
    const readUint32 = (): number => {
      if (plaintext!.byteLength - offset < 4) throw invalidPayload();
      const value = view.getUint32(offset, false);
      offset += 4;
      return value;
    };
    const readData = (): Uint8Array => {
      if (plaintext!.byteLength - offset < 8) throw invalidPayload();
      const length = view.getBigUint64(offset, false);
      offset += 8;
      if (length > BigInt(plaintext!.byteLength - offset) || length > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw invalidPayload();
      }
      const value = Uint8Array.from(plaintext!.subarray(offset, offset + Number(length)));
      offset += Number(length);
      return value;
    };

    const version = readUint32();
    parts.push(readData(), readData(), readData());
    valid = version === 3 && offset === plaintext.byteLength && parts.every(part => part.byteLength === AES_KEY_LENGTH);
    if (!valid) throw invalidPayload();
    const [encryptionKey, hmacKey, blobIdSalt] = parts as [Uint8Array, Uint8Array, Uint8Array];
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
  } finally {
    passwordBytes.fill(0);
    derived?.fill(0);
    plaintext?.fill(0);
    if (!valid) parts.forEach(part => part.fill(0));
  }
}

export function decryptArq7Object(encrypted: Uint8Array, keySet: Arq7KeySet): Uint8Array {
  // Arq's per-location `stretchEncryptionKey` flag belongs to encryption
  // version 1. Version 3 keysets use authenticated ARQO objects and ignore it.
  return decryptLegacyObject(encrypted, keySet);
}

function deriveKey(password: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, KEY_DERIVATION_ROUNDS, AES_KEY_LENGTH * 2, "sha256", (error, result) => {
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

function invalidPayload(): ArchiveFormatError {
  return new ArchiveFormatError("invalid_key_set", "The Arq 7 keyset payload has an unexpected structure or version");
}
