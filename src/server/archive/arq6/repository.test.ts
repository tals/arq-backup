import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { CloudBucket } from "../../../shared/contracts";
import type { CloudObject, CloudStorageProvider, ListObjectOptions, ObjectPage, ReadObjectOptions } from "../../cloud/provider";
import type { Arq7KeySet } from "../arq7/crypto";
import { parseArq6Snapshot } from "./models";
import { Arq6Repository } from "./repository";

const bucket: CloudBucket = { connectionId: 1, connectionLabel: "test", id: "bucket", name: "bucket" };

describe("experimental Arq 6 repository", () => {
  test("accepts fractional dates and derives optional volume fields from the dictionary key", () => {
    const creationDate = 1_712_345_678.25;
    const parsed = parseArq6Snapshot(Buffer.from(JSON.stringify({
      planUUID: "plan",
      creationDate,
      isComplete: true,
      snapshotVolumesByDiskIdentifier: {
        legacy: { arq5TreeBlobKey: { sha1: "0123456789abcdef0123456789abcdef01234567" } },
        disk1: { node: arq6Node({ isTree: true }) },
      },
    })));

    expect(parsed.creationDate).toBe(creationDate);
    expect(parsed.skippedNodeLessVolumes).toBe(1);
    expect(parsed.volumes).toHaveLength(1);
    expect(parsed.volumes[0]).toMatchObject({ diskIdentifier: "disk1", name: "", mountPoint: "" });
  });

  test("opens the latest complete snapshot and browses its version 1 tree", async () => {
    const provider = new FakeProvider();
    const keys = fakeKeySet();
    const fileBytes = Buffer.from("hello");
    const fileIdentifier = saltedIdentifier(keys, fileBytes);
    const treeBytes = treeWithFile("hello.txt", fileIdentifier, "objects/hello", 5);
    const treeIdentifier = saltedIdentifier(keys, treeBytes);
    const rootTree = arq6Node({
      isTree: true,
      treeBlobLoc: blobLocation(treeIdentifier, "objects/root.tree", 2),
      containedFilesCount: 1,
    });
    provider.put("plan/backupconfig.json", Buffer.from(JSON.stringify({ blobIdentifierType: 2 })));
    provider.put("plan/snapshots/00170/0000002.snapshot", lz4Literal(snapshot(rootTree, false, 1_700_000_002)));
    provider.put("plan/snapshots/00170/0000001.snapshot", lz4Literal(snapshot(rootTree, true, 1_700_000_001)));
    provider.put("plan/objects/root.tree", lz4Literal(treeBytes));
    provider.put("plan/objects/hello", fileBytes);

    const repository = new Arq6Repository(provider, bucket, "plan", keys);
    const folders = await repository.listBackupFolders();
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({
      id: "disk1",
      name: "Macintosh HD",
      localPath: "/",
      latestRecord: { id: "plan/snapshots/00170/0000001.snapshot", complete: true },
    });

    const [children, concurrentChildren] = await Promise.all([
      repository.listChildren(folders[0]!.latestRecord!.root.token),
      repository.listChildren(folders[0]!.latestRecord!.root.token),
    ]);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ name: "hello.txt", kind: "file", size: 5 });
    expect(concurrentChildren[0]?.token).toBe(children[0]?.token);
    expect(provider.reads.filter(name => name === "plan/objects/root.tree")).toHaveLength(1);
    expect(repository.restoreIdentity(children[0]!.token).split("\0")[0]).toBe("arq6");

    const chunks: Uint8Array[] = [];
    for await (const chunk of repository.readData(children[0]!.token)) chunks.push(Uint8Array.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from("hello"));
    repository.destroy();
  });
});

class FakeProvider implements CloudStorageProvider {
  readonly connectionId = 1;
  readonly connectionLabel = "test";
  readonly kind = "b2" as const;
  readonly objects = new Map<string, Uint8Array>();
  readonly reads: string[] = [];

  put(name: string, bytes: Uint8Array): void {
    this.objects.set(name, Uint8Array.from(bytes));
  }

  async listBuckets(): Promise<CloudBucket[]> {
    return [bucket];
  }

  async listObjects(_bucket: CloudBucket, options: ListObjectOptions = {}): Promise<ObjectPage> {
    const prefix = options.prefix ?? "";
    const objects: CloudObject[] = [...this.objects.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, bytes]) => ({ id: name, name, kind: "file", size: bytes.byteLength, uploadedAt: null }));
    return { objects, nextCursor: null };
  }

  async readObject(_bucket: CloudBucket, name: string, options?: ReadObjectOptions): Promise<Uint8Array> {
    this.reads.push(name);
    const value = this.objects.get(name);
    if (!value) throw new Error(`missing object ${name}`);
    if (!options?.range) return Uint8Array.from(value);
    return Uint8Array.from(value.subarray(options.range.start, (options.range.endInclusive ?? value.byteLength - 1) + 1));
  }
}

function snapshot(node: Record<string, unknown>, isComplete: boolean, creationDate: number): Uint8Array {
  return Buffer.from(JSON.stringify({
    planUUID: "plan",
    creationDate,
    isComplete,
    isImportedFromArq5: false,
    snapshotVolumesByDiskIdentifier: {
      legacy: {
        name: "Imported volume",
        arq5TreeBlobKey: { sha1: "0123456789abcdef0123456789abcdef01234567" },
      },
      disk1: {
        diskIdentifier: "disk1",
        name: "Macintosh HD",
        mountPoint: "/",
        node,
        isImportedFromArq5: false,
      },
    },
  }));
}

function arq6Node(options: {
  isTree: boolean;
  treeBlobLoc?: Record<string, unknown> | null;
  dataBlobLocs?: Record<string, unknown>[];
  itemSize?: number;
  containedFilesCount?: number;
}): Record<string, unknown> {
  return {
    isTree: options.isTree,
    treeBlobLoc: options.treeBlobLoc ?? null,
    dataBlobLocs: options.dataBlobLocs ?? [],
    itemSize: options.itemSize ?? 0,
    containedFilesCount: options.containedFilesCount ?? 0,
    modificationTime_sec: 1_700_000_000,
    modificationTime_nsec: 0,
    mac_st_mode: options.isTree ? 0o40755 : 0o100644,
    deleted: false,
  };
}

function blobLocation(identifier: string, relativePath: string, compressionType: 0 | 1 | 2): Record<string, unknown> {
  return {
    blobIdentifier: identifier,
    isPacked: false,
    relativePath,
    offset: 0,
    length: 0,
    stretchEncryptionKey: false,
    compressionType,
  };
}

function treeWithFile(name: string, blobIdentifier: string, relativePath: string, size: number): Uint8Array {
  return Buffer.concat([
    u32(1),
    u64(1),
    string(name),
    byte(0),
    u32(0),
    u64(1),
    string(blobIdentifier), byte(0), string(relativePath), u64(0), u64(size), byte(0), u32(0),
    byte(0),
    u64(0),
    u64(size),
    u64(1),
    i64(1_700_000_000), i64(0),
    i64(0), i64(0),
    i64(0), i64(0),
    byte(0), byte(0),
    byte(0),
    i32(0), u64(1), u32(0o100644), u32(1), u32(501), u32(20), i32(0), u32(0), u32(0),
  ]);
}

function lz4Literal(bytes: Uint8Array): Uint8Array {
  const header = u32(bytes.byteLength);
  if (bytes.byteLength < 15) return Buffer.concat([header, byte(bytes.byteLength << 4), bytes]);
  const extensions: number[] = [];
  let remaining = bytes.byteLength - 15;
  while (remaining >= 255) {
    extensions.push(255);
    remaining -= 255;
  }
  extensions.push(remaining);
  return Buffer.concat([header, byte(0xf0), Buffer.from(extensions), bytes]);
}

function string(value: string): Uint8Array {
  const bytes = Buffer.from(value);
  return Buffer.concat([byte(1), u64(bytes.byteLength), bytes]);
}

function byte(value: number): Uint8Array {
  return Uint8Array.of(value);
}

function u32(value: number): Uint8Array {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function i32(value: number): Uint8Array {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
}

function u64(value: number): Uint8Array {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function i64(value: number): Uint8Array {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64BE(BigInt(value));
  return bytes;
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

function saltedIdentifier(keys: Arq7KeySet, bytes: Uint8Array): string {
  return createHash("sha256").update(keys.blobIdSalt).update(bytes).digest("hex");
}
