import { describe, expect, test } from "bun:test";
import type { CloudBucket } from "../../../shared/contracts";
import type { CloudStorageProvider, ListObjectOptions, ObjectPage, ReadObjectOptions } from "../../cloud/provider";
import type { Arq7KeySet } from "./crypto";
import type { Arq7BlobLocation } from "./models";
import { Arq7Repository } from "./repository";

const bucket: CloudBucket = { connectionId: 1, connectionLabel: "test", id: "bucket", name: "bucket" };

describe("Arq 7 blob reading", () => {
  test("ranges packed blobs but reads loose objects in full and leaves raw plaintext alone", async () => {
    const provider = new FakeProvider();
    const repository = new Arq7Repository(provider, bucket, "plan", fakeKeySet());
    provider.objects.set("plan/packs/example.pack", Buffer.from("payload"));
    provider.objects.set("plan/objects/loose", Buffer.from("loose plaintext"));

    expect(await repository.readBlob(location("packs/example.pack", true, 2, 7))).toEqual(Buffer.from("payload"));
    expect(await repository.readBlob(location("objects/loose", false, 99, 1))).toEqual(Buffer.from("loose plaintext"));
    expect(provider.reads).toEqual([
      { name: "plan/packs/example.pack", options: { range: { start: 2, endInclusive: 8 } } },
      { name: "plan/objects/loose", options: undefined },
    ]);
    repository.destroy();
  });
});

class FakeProvider implements CloudStorageProvider {
  readonly connectionId = 1;
  readonly connectionLabel = "test";
  readonly kind = "b2" as const;
  readonly objects = new Map<string, Uint8Array>();
  readonly reads: Array<{ name: string; options: ReadObjectOptions | undefined }> = [];

  async listBuckets(): Promise<CloudBucket[]> {
    return [bucket];
  }

  async listObjects(_bucket: CloudBucket, _options?: ListObjectOptions): Promise<ObjectPage> {
    return { objects: [], nextCursor: null };
  }

  async readObject(_bucket: CloudBucket, name: string, options?: ReadObjectOptions): Promise<Uint8Array> {
    this.reads.push({ name, options });
    const value = this.objects.get(name);
    if (!value) throw new Error(`missing object ${name}`);
    if (!options?.range) return Uint8Array.from(value);
    return Uint8Array.from(value.subarray(options.range.start - 2, options.range.endInclusive! - 1));
  }
}

function location(relativePath: string, isPacked: boolean, offset: number, length: number): Arq7BlobLocation {
  return {
    blobIdentifier: "blob",
    isPacked,
    isLargePack: false,
    relativePath,
    offset,
    length,
    stretchEncryptionKey: false,
    compressionType: 0,
  };
}

function fakeKeySet(): Arq7KeySet {
  const encryptionKey = new Uint8Array(32);
  const hmacKey = new Uint8Array(32);
  const blobIdSalt = new Uint8Array(32);
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
}
