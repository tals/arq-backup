import { randomUUID } from "node:crypto";
import { BinaryReader } from "../common/binary-reader";
import { ArchiveFormatError } from "../common/errors";
import type { Arq7BlobLocation, Arq7Node } from "./models";

const MAX_TREE_ENTRIES = 10_000_000;

export type Arq7TreeEntry = {
  token: string;
  name: string;
  node: Arq7Node;
};

export function parseTree(bytes: Uint8Array): { version: number; entries: Arq7TreeEntry[] } {
  const reader = new BinaryReader(bytes, "Arq 7 tree");
  const version = reader.readUint32();
  const count = safeUint64(reader, "entry count");
  if (count > MAX_TREE_ENTRIES) throw formatError("has an absurd entry count");
  const entries: Arq7TreeEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = reader.readString(`entry ${index} name`);
    entries.push({ token: randomUUID(), name, node: readNode(reader, version) });
  }
  if (reader.remaining !== 0) throw formatError("has trailing bytes");
  return { version, entries };
}

function readNode(reader: BinaryReader, treeVersion: number): Arq7Node {
  const isTree = reader.readBoolean();
  const treeBlobLoc = isTree ? readBlobLocation(reader, treeVersion) : null;
  reader.readUint32(); // computerOSType
  const dataBlobCount = count(reader, "data blob");
  const dataBlobLocs = Array.from({ length: dataBlobCount }, () => readBlobLocation(reader, treeVersion));
  if (reader.readBoolean()) readBlobLocation(reader, treeVersion); // ACL (intentionally ignored)
  const xattrsCount = count(reader, "extended attribute");
  for (let index = 0; index < xattrsCount; index += 1) readBlobLocation(reader, treeVersion);
  const itemSize = safeUint64(reader, "item size");
  const containedFilesCount = safeUint64(reader, "contained files count");
  const modificationTimeSeconds = safeInt64(reader, "modification seconds");
  const modificationTimeNanoseconds = safeInt64(reader, "modification nanoseconds");
  reader.readInt64(); // changeTime_sec
  reader.readInt64(); // changeTime_nsec
  reader.readInt64(); // creationTime_sec
  reader.readInt64(); // creationTime_nsec
  reader.readNullableString(); // userName
  reader.readNullableString(); // groupName
  const deleted = reader.readBoolean();
  reader.readInt32(); // mac_st_dev
  reader.readUint64(); // mac_st_ino
  const mode = reader.readUint32() & 0xffff;
  reader.readUint32(); // mac_st_nlink
  reader.readUint32(); // mac_st_uid
  reader.readUint32(); // mac_st_gid
  reader.readInt32(); // mac_st_rdev
  reader.readUint32(); // mac_st_flags
  reader.readUint32(); // winAttrs
  if (treeVersion >= 2) {
    reader.readUint32(); // reparseTag
    reader.readBoolean(); // reparsePointIsDirectory
  }
  let isSparse = false;
  let sparseLogicalSize = 0;
  if (treeVersion > 3) {
    reader.readInt64(); // addedTime_sec
    reader.readInt64(); // addedTime_nsec
    reader.readUint32(); // documentID
    reader.readBoolean(); // hasDocumentID
    isSparse = reader.readBoolean();
    sparseLogicalSize = safeUint64(reader, "sparse logical size");
    const holes = count(reader, "sparse hole");
    for (let index = 0; index < holes; index += 1) {
      reader.readUint64();
      reader.readUint64();
    }
  }
  return {
    isTree,
    treeBlobLoc,
    dataBlobLocs,
    itemSize,
    containedFilesCount,
    modificationTimeSeconds,
    modificationTimeNanoseconds,
    mode,
    deleted,
    isSparse,
    sparseLogicalSize,
  };
}

function readBlobLocation(reader: BinaryReader, treeVersion: number): Arq7BlobLocation {
  const blobIdentifier = reader.readString("blob identifier");
  const isPacked = reader.readBoolean();
  const isLargePack = treeVersion >= 2 ? reader.readBoolean() : false;
  const relativePath = reader.readString("blob relative path");
  const offset = safeUint64(reader, "blob offset");
  const length = safeUint64(reader, "blob length");
  const stretchEncryptionKey = reader.readBoolean();
  const compressionType = reader.readUint32();
  if (compressionType !== 0 && compressionType !== 1 && compressionType !== 2) {
    throw formatError(`uses unsupported compression type ${compressionType}`);
  }
  return {
    blobIdentifier,
    isPacked,
    isLargePack,
    relativePath,
    offset,
    length,
    stretchEncryptionKey,
    compressionType,
  };
}

function count(reader: BinaryReader, description: string): number {
  const value = safeUint64(reader, `${description} count`);
  if (value > MAX_TREE_ENTRIES) throw formatError(`has an absurd ${description} count`);
  return value;
}

function safeUint64(reader: BinaryReader, description: string): number {
  const value = reader.readUint64();
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw formatError(`${description} is too large`);
  return Number(value);
}

function safeInt64(reader: BinaryReader, description: string): number {
  const value = reader.readInt64();
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw formatError(`${description} is out of range`);
  }
  return Number(value);
}

function formatError(detail: string): ArchiveFormatError {
  return new ArchiveFormatError("invalid_arq7_tree", `The Arq 7 tree ${detail}`);
}
