import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CloudBucket } from "../../../shared/contracts";
import type { CloudStorageProvider } from "../../cloud/provider";
import { ArchiveFormatError } from "../common/errors";

const SHA1_LENGTH = 20;
const PACK_HEADER_LENGTH = 16;
const PACK_MAGIC = Buffer.from("PACK");
const PACK_VERSION = 2;
const CACHE_DIRECTORY_MODE = 0o700;
const CACHE_FILE_MODE = 0o600;

type CacheKind = "index" | "pack";
type Validator = (bytes: Uint8Array) => void;
type FileIdentity = { device: number; inode: number; size: number; modified: number; changed: number };

/**
 * Durable cache for the original encrypted bytes from an Arq 5 tree packset.
 * It deliberately has no API for decrypted objects or archive keys.
 */
export class Arq5EncryptedDiskCache {
  readonly #scopeDirectory: string;
  readonly #inFlight = new Map<string, Promise<Uint8Array>>();
  readonly #validated = new Map<string, FileIdentity>();

  constructor(
    readonly provider: CloudStorageProvider,
    readonly bucket: CloudBucket,
    readonly prefix: string,
    cacheRoot: string,
  ) {
    const scope = createHash("sha256")
      .update(`${provider.connectionId}\0${bucket.id}\0${prefix}`)
      .digest("hex");
    this.#scopeDirectory = join(cacheRoot, scope);
  }

  async readIndex(objectName: string, validator: Validator): Promise<Uint8Array> {
    const cachePath = this.#cachePath(objectName, "index");
    return this.#readOrFetch(cachePath, objectName, validator);
  }

  async readPackRange(objectName: string, start: number, endInclusive: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || endInclusive < start) {
      throw new ArchiveFormatError("invalid_pack_index", "An Arq 5 packed-object range is invalid");
    }
    const cachePath = this.#cachePath(objectName, "pack");

    const identity = this.#validated.get(cachePath);
    if (identity) {
      try {
        const range = await readRange(cachePath, identity, start, endInclusive);
        if (range) return range;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      this.#validated.delete(cachePath);
    }

    const bytes = await this.#readOrFetch(cachePath, objectName, packValidator(objectName));
    return Uint8Array.from(bytes.subarray(start, endInclusive + 1));
  }

  destroy(): void {
    this.#validated.clear();
    this.#inFlight.clear();
  }

  async #readOrFetch(cachePath: string, objectName: string, validator: Validator): Promise<Uint8Array> {
    const active = this.#inFlight.get(cachePath);
    if (active) return active;

    const loading = this.#load(cachePath, objectName, validator).finally(() => {
      if (this.#inFlight.get(cachePath) === loading) this.#inFlight.delete(cachePath);
    });
    this.#inFlight.set(cachePath, loading);
    return loading;
  }

  async #load(cachePath: string, objectName: string, validator: Validator): Promise<Uint8Array> {
    let cached: { bytes: Uint8Array; identity: FileIdentity } | null = null;
    try {
      cached = await readStableFile(cachePath);
    } catch (error) {
      if (isNotFound(error)) {
        cached = null;
      } else if (error instanceof ArchiveFormatError && error.code === "unstable_pack_cache") {
        await unlink(cachePath).catch(unlinkError => {
          if (!isNotFound(unlinkError)) throw unlinkError;
        });
      } else {
        throw error;
      }
    }

    if (cached) {
      try {
        validator(cached.bytes);
        this.#validated.set(cachePath, cached.identity);
        return cached.bytes;
      } catch {
        await unlink(cachePath).catch(error => {
          if (!isNotFound(error)) throw error;
        });
        this.#validated.delete(cachePath);
      }
    }

    const remote = await this.provider.readObject(this.bucket, objectName);
    validator(remote);
    await atomicWrite(cachePath, remote);
    this.#validated.set(cachePath, identityFor(await stat(cachePath)));
    return remote;
  }

  #cachePath(objectName: string, kind: CacheKind): string {
    const filename = basename(objectName);
    const match = /^([a-fA-F0-9]{40})\.(index|pack)$/.exec(filename);
    if (!match || match[2] !== kind) {
      throw new ArchiveFormatError("invalid_pack_name", `Arq 5 ${kind} object has an invalid content-addressed name`);
    }
    return join(this.#scopeDirectory, `${match[1]!.toLowerCase()}.${kind}`);
  }
}

function packValidator(objectName: string): Validator {
  const expectedPackId = basename(objectName).slice(0, -".pack".length).toLowerCase();
  return bytes => {
    if (bytes.byteLength < PACK_HEADER_LENGTH + SHA1_LENGTH) {
      throw new ArchiveFormatError("invalid_pack", "An Arq 5 pack is truncated");
    }
    if (!Buffer.from(bytes.subarray(0, PACK_MAGIC.length)).equals(PACK_MAGIC)) {
      throw new ArchiveFormatError("invalid_pack", "An Arq 5 pack has an invalid signature");
    }
    if (new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false) !== PACK_VERSION) {
      throw new ArchiveFormatError("invalid_pack", "Only Arq 5 pack version 2 is supported");
    }
    const trailer = Buffer.from(bytes.subarray(-SHA1_LENGTH));
    const actual = createHash("sha1").update(bytes.subarray(0, -SHA1_LENGTH)).digest();
    if (!actual.equals(trailer)) {
      throw new ArchiveFormatError("invalid_pack", "An Arq 5 pack failed its SHA-1 integrity check");
    }
    const trailerPackId = trailer.toString("hex");
    const completePackId = createHash("sha1").update(bytes).digest("hex");
    if (trailerPackId !== expectedPackId && completePackId !== expectedPackId) {
      throw new ArchiveFormatError("invalid_pack", "An Arq 5 pack does not match its content-addressed name");
    }
  };
}

async function readRange(
  path: string,
  expectedIdentity: FileIdentity,
  start: number,
  endInclusive: number,
): Promise<Uint8Array | null> {
  const file = await open(path, "r");
  try {
    const before = identityFor(await file.stat());
    if (!sameIdentity(before, expectedIdentity)) return null;
    const size = Math.max(0, Math.min(endInclusive + 1, before.size) - start);
    const result = new Uint8Array(size);
    const { bytesRead } = await file.read(result, 0, size, start);
    const after = identityFor(await file.stat());
    if (bytesRead !== size || !sameIdentity(before, after)) return null;
    return result;
  } finally {
    await file.close();
  }
}

async function readStableFile(path: string): Promise<{ bytes: Uint8Array; identity: FileIdentity }> {
  const before = identityFor(await stat(path));
  const bytes = Uint8Array.from(await readFile(path));
  const after = identityFor(await stat(path));
  if (bytes.byteLength !== after.size || !sameIdentity(before, after)) {
    throw new ArchiveFormatError("unstable_pack_cache", "An Arq 5 cache file changed while it was being validated");
  }
  return { bytes, identity: after };
}

function identityFor(value: Stats): FileIdentity {
  return {
    device: value.dev,
    inode: value.ino,
    size: value.size,
    modified: value.mtimeMs,
    changed: value.ctimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modified === right.modified
    && left.changed === right.changed;
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const directory = path.slice(0, path.lastIndexOf("/"));
  await mkdir(directory, { recursive: true, mode: CACHE_DIRECTORY_MODE });
  await chmod(directory, CACHE_DIRECTORY_MODE);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporaryPath, "wx", CACHE_FILE_MODE);
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    await rename(temporaryPath, path);
    await chmod(path, CACHE_FILE_MODE);
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temporaryPath).catch(unlinkError => {
      if (!isNotFound(unlinkError)) throw unlinkError;
    });
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
