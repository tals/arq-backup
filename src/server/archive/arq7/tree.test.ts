import { describe, expect, test } from "bun:test";
import { parseTree } from "./tree";

describe("Arq 7 binary tree", () => {
  test("parses a v4 folder node and packed tree location", () => {
    const bytes = Buffer.concat([
      u32(4),
      u64(1),
      stringIo("Documents"),
      Buffer.from([1]),
      blobLocation(),
      u32(1),
      u64(0),
      Buffer.from([0]),
      u64(0),
      u64(0),
      u64(3),
      i64(1_700_000_000),
      i64(123_000_000),
      i64(1_700_000_001),
      i64(0),
      i64(1_600_000_000),
      i64(0),
      Buffer.from([0, 0, 0]),
      i32(0),
      u64(42),
      u32(0o40755),
      u32(1),
      u32(501),
      u32(20),
      i32(0),
      u32(0),
      u32(0),
      u32(0),
      Buffer.from([0]),
      i64(1_700_000_000),
      i64(0),
      u32(0),
      Buffer.from([0, 0]),
      u64(0),
      u64(0),
    ]);

    const tree = parseTree(bytes);
    expect(tree.version).toBe(4);
    expect(tree.entries).toHaveLength(1);
    expect(tree.entries[0]?.name).toBe("Documents");
    expect(tree.entries[0]?.node).toMatchObject({ isTree: true, containedFilesCount: 3, mode: 0o40755 });
    expect(tree.entries[0]?.node.treeBlobLoc).toMatchObject({
      relativePath: "/plan/treepacks/70/example.pack",
      offset: 10,
      length: 200,
      compressionType: 2,
    });
  });
});

function blobLocation(): Buffer {
  return Buffer.concat([
    stringIo("blob-id"),
    Buffer.from([1, 0]),
    stringIo("/plan/treepacks/70/example.pack"),
    u64(10),
    u64(200),
    Buffer.from([1]),
    u32(2),
  ]);
}

function stringIo(value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.from([1]), u64(bytes.byteLength), bytes]);
}

function u32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}

function i32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeInt32BE(value);
  return result;
}

function u64(value: number): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(BigInt(value));
  return result;
}

function i64(value: number): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigInt64BE(BigInt(value));
  return result;
}
