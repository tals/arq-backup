import { createHash } from "node:crypto";
import type { CloudBucket } from "../../../shared/contracts";
import type { CloudObject, CloudStorageProvider } from "../../cloud/provider";
import { appConfig } from "../../config";
import { BinaryReader } from "../common/binary-reader";
import { ArchiveFormatError } from "../common/errors";
import { Arq5EncryptedDiskCache } from "./encrypted-disk-cache";

const INDEX_HEADER_LENGTH = 4 + 4 + 256 * 4;
const INDEX_ENTRY_LENGTH = 40;
const SHA1_LENGTH = 20;
const INDEX_MAGIC = 0xff744f63;
const PACK_RECORD_OVERHEAD = 10;
const INDEX_CONCURRENCY = 4;

export type PackLocation = {
  packObjectName: string;
  offset: number;
  dataLength: number;
};

export function parseArq5PackIndex(bytes: Uint8Array, packObjectName: string): Map<string, PackLocation> {
  if (bytes.byteLength === 0) return new Map();
  if (bytes.byteLength < INDEX_HEADER_LENGTH + SHA1_LENGTH) {
    throw new ArchiveFormatError("invalid_pack_index", "An Arq 5 pack index is too short");
  }
  const storedChecksum = bytes.subarray(bytes.byteLength - SHA1_LENGTH);
  const actualChecksum = createHash("sha1").update(bytes.subarray(0, -SHA1_LENGTH)).digest();
  if (!actualChecksum.equals(storedChecksum)) {
    throw new ArchiveFormatError("invalid_pack_index", "An Arq 5 pack index failed its SHA-1 integrity check");
  }

  const reader = new BinaryReader(bytes, "Arq 5 pack index");
  if (reader.readUint32() !== INDEX_MAGIC) throw new ArchiveFormatError("invalid_pack_index", "An Arq 5 pack index has an invalid signature");
  if (reader.readUint32() !== 2) throw new ArchiveFormatError("invalid_pack_index", "Only Arq 5 pack-index version 2 is supported");
  let count = 0;
  for (let index = 0; index < 256; index += 1) count = reader.readUint32();
  const required = INDEX_HEADER_LENGTH + count * INDEX_ENTRY_LENGTH + SHA1_LENGTH;
  if (required > bytes.byteLength) throw new ArchiveFormatError("invalid_pack_index", "An Arq 5 pack index is truncated");

  const locations = new Map<string, PackLocation>();
  for (let index = 0; index < count; index += 1) {
    const offset = safeNumber(reader.readUint64(), "pack offset");
    const dataLength = safeNumber(reader.readUint64(), "packed-object length");
    const sha1 = Buffer.from(reader.readBytes(SHA1_LENGTH)).toString("hex");
    reader.readBytes(4);
    if (dataLength <= 0) throw new ArchiveFormatError("invalid_pack_index", "An Arq 5 pack index contains an empty object");
    locations.set(sha1, { packObjectName, offset, dataLength });
  }
  return locations;
}

export class Arq5PackSet {
  readonly #locations = new Map<string, PackLocation>();
  readonly #cache: Arq5EncryptedDiskCache | null;
  #preparePromise: Promise<void> | null = null;

  constructor(
    readonly provider: CloudStorageProvider,
    readonly bucket: CloudBucket,
    readonly prefix: string,
    cacheRoot: string | null = appConfig.legacyTreePackCachePath,
    readonly requireArqo = true,
  ) {
    this.#cache = cacheRoot === null ? null : new Arq5EncryptedDiskCache(provider, bucket, prefix, cacheRoot);
  }

  prepare(): Promise<void> {
    this.#preparePromise ??= this.#loadIndexes();
    return this.#preparePromise;
  }

  async readObject(sha1: string): Promise<Uint8Array> {
    await this.prepare();
    const location = this.#locations.get(sha1.toLowerCase());
    if (!location) throw new ArchiveFormatError("missing_packed_object", `Arq 5 object ${sha1} was not found in its tree packset`);
    const endInclusive = location.offset + location.dataLength + PACK_RECORD_OVERHEAD - 1;
    if (!Number.isSafeInteger(endInclusive)) throw new ArchiveFormatError("invalid_pack_index", "An Arq 5 packed-object range is too large");
    let range = await this.#readRange(location.packObjectName, location.offset, endInclusive);
    if (this.requireArqo && startsWithArqo(range)) return Uint8Array.from(range.subarray(0, location.dataLength));
    try {
      return extractPackRecord(range, location.dataLength, this.requireArqo);
    } catch (error) {
      if (!(error instanceof ArchiveFormatError) || error.code !== "unexpected_end_of_data") throw error;
      const expandedEnd = location.offset + location.dataLength + 65_536 - 1;
      range = await this.#readRange(location.packObjectName, location.offset, expandedEnd);
      return extractPackRecord(range, location.dataLength, this.requireArqo);
    }
  }

  destroy(): void {
    this.#locations.clear();
    this.#cache?.destroy();
  }

  async #loadIndexes(): Promise<void> {
    const indexes = await listAll(this.provider, this.bucket, this.prefix);
    const files = indexes.filter(object => object.kind === "file" && object.name.endsWith(".index"));
    await mapConcurrent(files, INDEX_CONCURRENCY, async object => {
      const packObjectName = `${object.name.slice(0, -".index".length)}.pack`;
      const bytes = this.#cache
        ? await this.#cache.readIndex(object.name, candidate => {
            parseArq5PackIndex(candidate, packObjectName);
          })
        : await this.provider.readObject(this.bucket, object.name);
      for (const [sha1, location] of parseArq5PackIndex(bytes, packObjectName)) {
        this.#locations.set(sha1, location);
      }
    });
  }

  #readRange(objectName: string, start: number, endInclusive: number): Promise<Uint8Array> {
    return this.#cache
      ? this.#cache.readPackRange(objectName, start, endInclusive)
      : this.provider.readObject(this.bucket, objectName, { range: { start, endInclusive } });
  }
}

export function extractPackRecord(bytes: Uint8Array, expectedLength: number, requireArqo = true): Uint8Array {
  const reader = new BinaryReader(bytes, "Arq 5 pack record");
  reader.readNullableString();
  reader.readNullableString();
  const declaredLength = safeNumber(reader.readUint64(), "pack record length");
  if (declaredLength !== expectedLength) {
    throw new ArchiveFormatError("invalid_pack_record", "An Arq 5 pack record disagrees with its index length");
  }
  const data = reader.readBytes(declaredLength);
  if (requireArqo && !startsWithArqo(data)) throw new ArchiveFormatError("invalid_pack_record", "An Arq 5 packed object has no ARQO header");
  return Uint8Array.from(data);
}

async function listAll(
  provider: CloudStorageProvider,
  bucket: CloudBucket,
  prefix: string,
): Promise<CloudObject[]> {
  const objects: CloudObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await provider.listObjects(bucket, { prefix, cursor, limit: 10_000 });
    objects.push(...page.objects);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return objects;
}

async function mapConcurrent<T>(values: T[], concurrency: number, action: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      const value = values[index];
      if (value === undefined) return;
      await action(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ArchiveFormatError("invalid_pack_index", `An Arq 5 ${label} is too large`);
  return Number(value);
}

function startsWithArqo(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x41 && bytes[1] === 0x52 && bytes[2] === 0x51 && bytes[3] === 0x4f;
}
