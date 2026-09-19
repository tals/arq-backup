import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudBucket } from "../../../shared/contracts";
import type { CloudStorageProvider, ListObjectOptions, ObjectPage, ReadObjectOptions } from "../../cloud/provider";
import { Arq5EncryptedDiskCache } from "./encrypted-disk-cache";

const temporaryDirectories: string[] = [];
const bucket: CloudBucket = { connectionId: 17, connectionLabel: "test", id: "bucket-id", name: "bucket" };
const prefix = "computer/packsets/folder-trees/";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("encrypted Arq 5 tree-pack disk cache", () => {
  test("downloads a full pack once, validates it, and reuses its encrypted bytes across instances", async () => {
    const cacheRoot = await temporaryDirectory();
    const { bytes, id } = makePack();
    const objectName = `${prefix}${id}.pack`;
    const provider = new FakeProvider(new Map([[objectName, bytes]]));
    const events: string[] = [];

    const first = new Arq5EncryptedDiskCache(provider, bucket, prefix, cacheRoot, event => events.push(event));
    expect(await first.readPackRange(objectName, 0, 7)).toEqual(bytes.subarray(0, 8));
    first.destroy();

    const second = new Arq5EncryptedDiskCache(provider, bucket, prefix, cacheRoot, event => events.push(event));
    expect(await second.readPackRange(objectName, 4, 15)).toEqual(bytes.subarray(4, 16));
    expect(provider.reads).toEqual([objectName]);
    expect(events).toEqual(["pack_cache_miss", "pack_downloaded"]);

    const cachePath = scopedPath(cacheRoot, id, "pack");
    expect(await readFile(cachePath)).toEqual(Buffer.from(bytes));
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(cacheRoot, scope()))).mode & 0o777).toBe(0o700);
  });

  test("accepts both canonical complete-pack IDs and the older trailer-named pack layout", async () => {
    const cacheRoot = await temporaryDirectory();
    const { bytes, id: trailerId } = makePack();
    const completeId = createHash("sha1").update(bytes).digest("hex");
    const objects = new Map<string, Uint8Array>([
      [`${prefix}${trailerId}.pack`, bytes],
      [`${prefix}${completeId}.pack`, bytes],
    ]);
    const provider = new FakeProvider(objects);
    const cache = new Arq5EncryptedDiskCache(provider, bucket, prefix, cacheRoot);

    expect(await cache.readPackRange(`${prefix}${trailerId}.pack`, 0, 3)).toEqual(Buffer.from("PACK"));
    expect(await cache.readPackRange(`${prefix}${completeId}.pack`, 0, 3)).toEqual(Buffer.from("PACK"));
    expect(provider.reads).toHaveLength(2);
  });

  test("replaces a corrupt local pack from B2 but hard-errors on corrupt remote bytes", async () => {
    const cacheRoot = await temporaryDirectory();
    const { bytes, id } = makePack();
    const objectName = `${prefix}${id}.pack`;
    const provider = new FakeProvider(new Map([[objectName, bytes]]));
    await new Arq5EncryptedDiskCache(provider, bucket, prefix, cacheRoot).readPackRange(objectName, 0, 3);

    const cachePath = scopedPath(cacheRoot, id, "pack");
    await chmod(cachePath, 0o600);
    await writeFile(cachePath, Buffer.from("corrupt"));
    await new Arq5EncryptedDiskCache(provider, bucket, prefix, cacheRoot).readPackRange(objectName, 0, 3);
    expect(provider.reads).toHaveLength(2);
    expect(await readFile(cachePath)).toEqual(Buffer.from(bytes));

    await writeFile(cachePath, Buffer.from("corrupt again"));
    provider.objects.set(objectName, Buffer.from("bad remote data"));
    await expect(new Arq5EncryptedDiskCache(provider, bucket, prefix, cacheRoot).readPackRange(objectName, 0, 3))
      .rejects.toMatchObject({ code: "invalid_pack" });
    expect(provider.reads).toHaveLength(3);
  });

  test("revalidates a pack if its cache file changes during the same process", async () => {
    const cacheRoot = await temporaryDirectory();
    const { bytes, id } = makePack();
    const objectName = `${prefix}${id}.pack`;
    const provider = new FakeProvider(new Map([[objectName, bytes]]));
    const cache = new Arq5EncryptedDiskCache(provider, bucket, prefix, cacheRoot);
    await cache.readPackRange(objectName, 0, 3);

    await writeFile(scopedPath(cacheRoot, id, "pack"), Buffer.from("corrupt"));
    expect(await cache.readPackRange(objectName, 0, 3)).toEqual(Buffer.from("PACK"));
    expect(provider.reads).toHaveLength(2);
  });

  test("reads raw indexes without persisting them", async () => {
    const cacheRoot = await temporaryDirectory();
    const id = "a".repeat(40);
    const objectName = `${prefix}${id}.index`;
    const indexBytes = Buffer.from("raw-index-checksum-ok");
    const provider = new FakeProvider(new Map([[objectName, indexBytes]]));
    expect(await new Arq5EncryptedDiskCache(provider, bucket, prefix, cacheRoot).readIndex(objectName)).toEqual(indexBytes);
    expect(await new Arq5EncryptedDiskCache(provider, bucket, prefix, cacheRoot).readIndex(objectName)).toEqual(indexBytes);
    expect(provider.reads).toEqual([objectName, objectName]);
    await expect(readFile(scopedPath(cacheRoot, id, "index"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

class FakeProvider implements CloudStorageProvider {
  readonly connectionId = bucket.connectionId;
  readonly connectionLabel = bucket.connectionLabel;
  readonly kind = "b2" as const;
  readonly reads: string[] = [];

  constructor(readonly objects: Map<string, Uint8Array>) {}

  async listBuckets(): Promise<CloudBucket[]> {
    return [bucket];
  }

  async listObjects(_bucket: CloudBucket, _options?: ListObjectOptions): Promise<ObjectPage> {
    return { objects: [], nextCursor: null };
  }

  async readObject(_bucket: CloudBucket, objectName: string, _options?: ReadObjectOptions): Promise<Uint8Array> {
    this.reads.push(objectName);
    const bytes = this.objects.get(objectName);
    if (!bytes) throw new Error(`Missing fake object ${objectName}`);
    return Uint8Array.from(bytes);
  }
}

function makePack(): { bytes: Uint8Array; id: string } {
  const body = Buffer.alloc(16);
  body.write("PACK", 0, "ascii");
  body.writeUInt32BE(2, 4);
  body.writeBigUInt64BE(0n, 8);
  const trailer = createHash("sha1").update(body).digest();
  return { bytes: Buffer.concat([body, trailer]), id: trailer.toString("hex") };
}

function scope(): string {
  return createHash("sha256").update(`${bucket.connectionId}\0${bucket.id}\0${prefix}`).digest("hex");
}

function scopedPath(cacheRoot: string, id: string, extension: "pack" | "index"): string {
  return join(cacheRoot, scope(), `${id}.${extension}`);
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "arq5-encrypted-cache-"));
  temporaryDirectories.push(path);
  return path;
}
