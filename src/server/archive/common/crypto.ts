import { createDecipheriv, createHmac, pbkdf2, timingSafeEqual } from "node:crypto";
import { ArchiveFormatError } from "./errors";

const KEY_SET_HEADER = Buffer.from("ARQ_ENCRYPTED_MASTER_KEYS", "ascii");
const OBJECT_HEADER = Buffer.from("ARQO", "ascii");
const SALT_LENGTH = 8;
const SHA256_LENGTH = 32;
const AES_BLOCK_LENGTH = 16;
const AES_KEY_LENGTH = 32;
const ENCRYPTED_METADATA_LENGTH = 64;
const KEY_DERIVATION_ROUNDS = 200_000;

export type LegacyKeySet = {
  encryptionKey: Uint8Array;
  hmacKey: Uint8Array;
  blobIdSalt: Uint8Array;
  destroy(): void;
};

export async function unlockLegacyKeySet(encrypted: Uint8Array, password: string): Promise<LegacyKeySet> {
  const preambleLength = KEY_SET_HEADER.length + SALT_LENGTH + SHA256_LENGTH + AES_BLOCK_LENGTH;
  if (encrypted.byteLength <= preambleLength || !startsWith(encrypted, KEY_SET_HEADER)) {
    throw new ArchiveFormatError("invalid_key_set", "The encrypted master key file has an invalid header or length");
  }

  const saltOffset = KEY_SET_HEADER.length;
  const hmacOffset = saltOffset + SALT_LENGTH;
  const ivOffset = hmacOffset + SHA256_LENGTH;
  const ciphertextOffset = ivOffset + AES_BLOCK_LENGTH;
  const passwordBytes = Buffer.from(password, "utf8");
  let derived: Buffer | null = null;
  let plaintext: Buffer | null = null;

  try {
    derived = await deriveKey(passwordBytes, encrypted.subarray(saltOffset, hmacOffset));
    const derivedEncryptionKey = derived.subarray(0, AES_KEY_LENGTH);
    const derivedHmacKey = derived.subarray(AES_KEY_LENGTH);
    const expectedHmac = createHmac("sha256", derivedHmacKey).update(encrypted.subarray(ivOffset)).digest();
    if (!safeEqual(expectedHmac, encrypted.subarray(hmacOffset, ivOffset))) {
      throw new ArchiveFormatError("incorrect_password", "The Encryption Password is incorrect");
    }

    try {
      plaintext = decryptAesCbc(
        encrypted.subarray(ciphertextOffset),
        derivedEncryptionKey,
        encrypted.subarray(ivOffset, ciphertextOffset),
      );
    } catch {
      throw new ArchiveFormatError("invalid_key_set", "The encrypted master key payload could not be decrypted");
    }
    if (plaintext.byteLength !== AES_KEY_LENGTH * 3) {
      throw new ArchiveFormatError("invalid_key_set", "The decrypted master key payload has an unexpected length");
    }

    const encryptionKey = Uint8Array.from(plaintext.subarray(0, AES_KEY_LENGTH));
    const hmacKey = Uint8Array.from(plaintext.subarray(AES_KEY_LENGTH, AES_KEY_LENGTH * 2));
    const blobIdSalt = Uint8Array.from(plaintext.subarray(AES_KEY_LENGTH * 2));
    return {
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
  }
}

export function decryptLegacyObject(
  encrypted: Uint8Array,
  keySet: Pick<LegacyKeySet, "encryptionKey" | "hmacKey">,
): Uint8Array {
  const hmacOffset = OBJECT_HEADER.length;
  const ivOffset = hmacOffset + SHA256_LENGTH;
  const metadataOffset = ivOffset + AES_BLOCK_LENGTH;
  const ciphertextOffset = metadataOffset + ENCRYPTED_METADATA_LENGTH;
  if (encrypted.byteLength <= ciphertextOffset || !startsWith(encrypted, OBJECT_HEADER)) {
    throw new ArchiveFormatError("invalid_encrypted_object", "The encrypted object has an invalid header or length");
  }

  const expectedHmac = createHmac("sha256", keySet.hmacKey).update(encrypted.subarray(ivOffset)).digest();
  if (!safeEqual(expectedHmac, encrypted.subarray(hmacOffset, ivOffset))) {
    throw new ArchiveFormatError("object_authentication_failed", "The encrypted object's authentication code does not match");
  }

  let metadata: Buffer;
  try {
    metadata = decryptAesCbc(
      encrypted.subarray(metadataOffset, ciphertextOffset),
      keySet.encryptionKey,
      encrypted.subarray(ivOffset, metadataOffset),
    );
  } catch {
    throw new ArchiveFormatError("invalid_encrypted_object", "The encrypted object metadata could not be decrypted");
  }
  if (metadata.byteLength !== AES_BLOCK_LENGTH + AES_KEY_LENGTH) {
    metadata.fill(0);
    throw new ArchiveFormatError("invalid_encrypted_object", "The encrypted object metadata has an unexpected length");
  }

  try {
    return Uint8Array.from(
      decryptAesCbc(
        encrypted.subarray(ciphertextOffset),
        metadata.subarray(AES_BLOCK_LENGTH),
        metadata.subarray(0, AES_BLOCK_LENGTH),
      ),
    );
  } catch {
    throw new ArchiveFormatError("invalid_encrypted_object", "The encrypted object data could not be decrypted");
  } finally {
    metadata.fill(0);
  }
}

function deriveKey(password: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, KEY_DERIVATION_ROUNDS, AES_KEY_LENGTH * 2, "sha1", (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function decryptAesCbc(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer {
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function startsWith(value: Uint8Array, prefix: Uint8Array): boolean {
  return value.byteLength >= prefix.byteLength && prefix.every((byte, index) => value[index] === byte);
}

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
