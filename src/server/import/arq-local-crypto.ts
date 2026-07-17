import { createDecipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { ArchiveFormatError } from "../archive/common/errors";

const KEY_SET_HEADER = Buffer.from("ARQ_ENCRYPTED_MASTER_KEYS", "ascii");
// Arq 7's PasswordCryptor V2 format uses this program constant. It is not a
// user or machine secret. The nearby 64-character constant in ArqAgent belongs
// to a different code path and cannot authenticate localkeysv2.dat.
const LOCAL_KEY_PASSWORD = "PasswordCryptor";
const SALT_LENGTH = 8;
const SHA256_LENGTH = 32;
const AES_BLOCK_LENGTH = 16;
const AES_KEY_LENGTH = 32;
const KEY_DERIVATION_ROUNDS = 200_000;

export type ArqLocalKeySet = {
  version: number;
  encryptionKey: Uint8Array;
  hmacKey: Uint8Array;
  blobIdSalt: Uint8Array;
  destroy(): void;
};

/**
 * Opens Arq 7's machine-local key envelope. This password is an Arq program
 * constant, not the user's backup encryption password.
 */
export function openArqLocalKeySet(encrypted: Uint8Array): ArqLocalKeySet {
  const saltOffset = KEY_SET_HEADER.length;
  const hmacOffset = saltOffset + SALT_LENGTH;
  const ivOffset = hmacOffset + SHA256_LENGTH;
  const ciphertextOffset = ivOffset + AES_BLOCK_LENGTH;
  if (encrypted.byteLength <= ciphertextOffset || !startsWith(encrypted, KEY_SET_HEADER)) {
    throw new ArchiveFormatError("invalid_local_key_set", "Arq's local key file has an invalid header or length");
  }

  let derived: Buffer | null = null;
  let plaintext: Buffer | null = null;
  try {
    derived = pbkdf2Sync(
      LOCAL_KEY_PASSWORD,
      encrypted.subarray(saltOffset, hmacOffset),
      KEY_DERIVATION_ROUNDS,
      AES_KEY_LENGTH * 2,
      "sha256",
    );
    const expectedHmac = createHmac("sha256", derived.subarray(AES_KEY_LENGTH))
      .update(encrypted.subarray(ivOffset))
      .digest();
    if (!safeEqual(expectedHmac, encrypted.subarray(hmacOffset, ivOffset))) {
      throw new ArchiveFormatError("local_key_authentication_failed", "Arq's local key file failed authentication");
    }

    try {
      plaintext = decryptAesCbc(
        encrypted.subarray(ciphertextOffset),
        derived.subarray(0, AES_KEY_LENGTH),
        encrypted.subarray(ivOffset, ciphertextOffset),
      );
    } catch {
      throw new ArchiveFormatError("invalid_local_key_set", "Arq's local key payload could not be decrypted");
    }

    const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
    let offset = 0;
    const readUint32 = (): number => {
      if (plaintext!.byteLength - offset < 4) throw invalidLocalKeyPayload();
      const value = view.getUint32(offset, false);
      offset += 4;
      return value;
    };
    const readData = (): Uint8Array => {
      if (plaintext!.byteLength - offset < 8) throw invalidLocalKeyPayload();
      const length = view.getBigUint64(offset, false);
      offset += 8;
      if (length > BigInt(plaintext!.byteLength - offset) || length > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw invalidLocalKeyPayload();
      }
      const value = Uint8Array.from(plaintext!.subarray(offset, offset + Number(length)));
      offset += Number(length);
      return value;
    };

    const version = readUint32();
    const parts: Uint8Array[] = [];
    let valid = false;
    try {
      parts.push(readData(), readData(), readData());
      valid =
        version === 3 &&
        offset === plaintext.byteLength &&
        parts.every(part => part.byteLength === AES_KEY_LENGTH);
      if (!valid) throw invalidLocalKeyPayload();
    } finally {
      if (!valid) parts.forEach(part => part.fill(0));
    }
    const [encryptionKey, hmacKey, blobIdSalt] = parts as [Uint8Array, Uint8Array, Uint8Array];

    return {
      version,
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
    derived?.fill(0);
    plaintext?.fill(0);
  }
}

function invalidLocalKeyPayload(): ArchiveFormatError {
  return new ArchiveFormatError("invalid_local_key_set", "Arq's local key payload has an unexpected structure");
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
