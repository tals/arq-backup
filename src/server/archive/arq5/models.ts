import { BinaryReader } from "../common/binary-reader";
import { ArchiveFormatError } from "../common/errors";

export type Arq5Compression = 0 | 1 | 2;

export type Arq5BlobKey = {
  sha1: string;
  stretched: boolean;
  compression: Arq5Compression;
  storageType: number;
};

export type Arq5Node = {
  isTree: boolean;
  containsMissingItems: boolean;
  dataBlobKeys: Arq5BlobKey[];
  uncompressedSize: bigint;
  mode: number;
  modifiedSeconds: bigint;
  modifiedNanoseconds: bigint;
};

export type Arq5Tree = {
  version: number;
  rootMode: number;
  rootModifiedSeconds: bigint;
  rootModifiedNanoseconds: bigint;
  children: Map<string, Arq5Node>;
};

export type Arq5Commit = {
  version: number;
  parent: Arq5BlobKey | null;
  tree: Arq5BlobKey;
  location: string | null;
  createdAt: Date;
  complete: boolean;
  hasMissingNodes: boolean;
};

export function parseArq5Commit(bytes: Uint8Array): Arq5Commit {
  const reader = new BinaryReader(bytes, "Arq 5 commit");
  const header = reader.readAscii(10);
  const match = /^CommitV(\d{3})$/.exec(header);
  if (!match) throw new ArchiveFormatError("invalid_commit", "The Arq 5 Backup Record header is invalid");
  const version = Number(match[1]);
  if (version < 2 || version > 12) {
    throw new ArchiveFormatError("unsupported_commit", `Arq 5 Commit version ${version} is not supported`);
  }

  reader.readNullableString(); // author
  reader.readNullableString(); // comment
  const parentCount = reader.readCount("parent commit");
  let parent: Arq5BlobKey | null = null;
  for (let index = 0; index < parentCount; index += 1) {
    const sha1 = readSha1(reader, "parent commit");
    const stretched = version >= 4 ? reader.readBoolean() : false;
    if (!parent) parent = { sha1, stretched, compression: 0, storageType: 1 };
  }

  const treeSha1 = readSha1(reader, "tree");
  const treeStretched = version >= 4 ? reader.readBoolean() : false;
  let treeCompression: Arq5Compression = 0;
  if (version >= 8 && version <= 9) treeCompression = reader.readBoolean() ? 1 : 0;
  else if (version >= 10) treeCompression = readCompression(reader.readInt32(), "commit tree");

  const location = reader.readNullableString();
  if (version < 8) {
    reader.readNullableString();
    if (version >= 4) reader.readBoolean();
  }
  const createdAt = reader.readDate();
  if (!createdAt) throw new ArchiveFormatError("invalid_commit", "The Arq 5 Backup Record has no creation date");
  if (version >= 3) {
    const failureCount = reader.readCount("failed file");
    for (let index = 0; index < failureCount; index += 1) {
      reader.readNullableString();
      reader.readNullableString();
    }
  }
  const hasMissingNodes = version >= 8 ? reader.readBoolean() : false;
  const complete = version >= 9 ? reader.readBoolean() : true;
  if (version >= 5) reader.readData();
  if (version >= 12) reader.readNullableString();

  return {
    version,
    parent,
    tree: { sha1: treeSha1, stretched: treeStretched, compression: treeCompression, storageType: 1 },
    location,
    createdAt,
    complete,
    hasMissingNodes,
  };
}

export function parseArq5Tree(bytes: Uint8Array): Arq5Tree {
  const reader = new BinaryReader(bytes, "Arq 5 tree");
  const header = reader.readAscii(8);
  const match = /^TreeV(\d{3})$/.exec(header);
  if (!match) throw new ArchiveFormatError("invalid_tree", "The Arq 5 folder tree header is invalid");
  const version = Number(match[1]);
  if (version < 10 || version > 22 || version === 13) {
    throw new ArchiveFormatError("unsupported_tree", `Arq 5 Tree version ${version} is not supported`);
  }

  let xattrsCompression: Arq5Compression = 0;
  let aclCompression: Arq5Compression = 0;
  if (version >= 12 && version <= 18) {
    xattrsCompression = reader.readBoolean() ? 1 : 0;
    aclCompression = reader.readBoolean() ? 1 : 0;
  } else if (version >= 19) {
    xattrsCompression = readCompression(reader.readInt32(), "tree extended attributes");
    aclCompression = readCompression(reader.readInt32(), "tree ACL");
  }
  readBlobKey(reader, version, xattrsCompression);
  reader.readUint64();
  readBlobKey(reader, version, aclCompression);
  reader.readInt32(); // uid
  reader.readInt32(); // gid
  const rootMode = reader.readInt32();
  const rootModifiedSeconds = reader.readInt64();
  const rootModifiedNanoseconds = reader.readInt64();
  reader.readInt64(); // flags
  reader.readInt32(); // finder flags
  reader.readInt32(); // extended finder flags
  reader.readInt32(); // device
  reader.readInt32(); // inode
  reader.readUint32(); // link count
  reader.readInt32(); // device type
  reader.readInt64(); // ctime seconds
  reader.readInt64(); // ctime nanoseconds
  reader.readInt64(); // blocks
  reader.readUint32(); // block size
  if (version >= 11 && version <= 16) reader.readUint64();
  if (version >= 15) {
    reader.readInt64();
    reader.readInt64();
  }
  if (version >= 18) {
    const missingCount = readUint32Count(reader, "missing node");
    if (missingCount > 0) {
      throw new ArchiveFormatError(
        "incomplete_tree",
        `The Arq 5 folder tree reports ${missingCount} missing archived item${missingCount === 1 ? "" : "s"}`,
      );
    }
    for (let index = 0; index < missingCount; index += 1) {
      reader.readString("missing node name");
      readNode(reader, version);
    }
  }

  const childCount = readUint32Count(reader, "child node");
  const children = new Map<string, Arq5Node>();
  for (let index = 0; index < childCount; index += 1) {
    const name = reader.readString("child node name");
    children.set(name, readNode(reader, version));
  }
  return { version, rootMode, rootModifiedSeconds, rootModifiedNanoseconds, children };
}

function readNode(reader: BinaryReader, version: number): Arq5Node {
  const isTree = reader.readBoolean();
  const containsMissingItems = version >= 18 ? reader.readBoolean() : false;
  let dataCompression: Arq5Compression = 0;
  let xattrsCompression: Arq5Compression = 0;
  let aclCompression: Arq5Compression = 0;
  if (version >= 12 && version <= 18) {
    dataCompression = reader.readBoolean() ? 1 : 0;
    xattrsCompression = reader.readBoolean() ? 1 : 0;
    aclCompression = reader.readBoolean() ? 1 : 0;
  } else if (version >= 19) {
    dataCompression = readCompression(reader.readInt32(), "node data");
    xattrsCompression = readCompression(reader.readInt32(), "node extended attributes");
    aclCompression = readCompression(reader.readInt32(), "node ACL");
  }

  const dataBlobCount = reader.readInt32();
  if (dataBlobCount < 0 || dataBlobCount > 10_000_000) {
    throw new ArchiveFormatError("invalid_tree", "The Arq 5 node has an invalid data-blob count");
  }
  const dataBlobKeys: Arq5BlobKey[] = [];
  for (let index = 0; index < dataBlobCount; index += 1) {
    const key = readBlobKey(reader, version, dataCompression);
    if (!key) throw new ArchiveFormatError("invalid_tree", "The Arq 5 node contains an empty data-blob key");
    dataBlobKeys.push(key);
  }
  const uncompressedSize = reader.readUint64();
  if (version < 18) {
    readBlobKey(reader, version, 0);
    readBlobKey(reader, version, 0);
  }
  readBlobKey(reader, version, xattrsCompression);
  reader.readUint64();
  readBlobKey(reader, version, aclCompression);
  reader.readInt32(); // uid
  reader.readInt32(); // gid
  const mode = reader.readInt32();
  const modifiedSeconds = reader.readInt64();
  const modifiedNanoseconds = reader.readInt64();
  reader.readInt64(); // flags
  reader.readInt32(); // finder flags
  reader.readInt32(); // extended finder flags
  reader.readNullableString(); // finder file type
  reader.readNullableString(); // finder creator
  reader.readBoolean(); // extension hidden
  reader.readInt32(); // device
  reader.readInt32(); // inode
  reader.readUint32(); // link count
  reader.readInt32(); // device type
  reader.readInt64(); // ctime seconds
  reader.readInt64(); // ctime nanoseconds
  reader.readInt64(); // create seconds
  reader.readInt64(); // create nanoseconds
  reader.readInt64(); // blocks
  reader.readUint32(); // block size

  if (isTree && dataBlobKeys.length === 0) {
    throw new ArchiveFormatError("invalid_tree", "An Arq 5 folder node has no child-tree key");
  }
  if (containsMissingItems) {
    throw new ArchiveFormatError("incomplete_tree", "An Arq 5 folder node reports missing archived items");
  }
  return { isTree, containsMissingItems, dataBlobKeys, uncompressedSize, mode, modifiedSeconds, modifiedNanoseconds };
}

function readBlobKey(
  reader: BinaryReader,
  treeVersion: number,
  compression: Arq5Compression,
): Arq5BlobKey | null {
  const sha1 = reader.readNullableString();
  const stretched = treeVersion >= 14 ? reader.readBoolean() : false;
  let storageType = 1;
  if (treeVersion >= 17) {
    storageType = reader.readUint32();
    reader.readNullableString(); // archive id
    reader.readUint64(); // archive size
    reader.readDate(); // archive upload date
  }
  if (sha1 === null) return null;
  if (!/^[0-9a-f]{40}$/i.test(sha1)) throw new ArchiveFormatError("invalid_blob_key", "An Arq 5 blob key is not a SHA-1");
  return { sha1: sha1.toLowerCase(), stretched, compression, storageType };
}

function readSha1(reader: BinaryReader, label: string): string {
  const value = reader.readString(label);
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new ArchiveFormatError("invalid_blob_key", `The Arq 5 ${label} key is not a SHA-1`);
  return value.toLowerCase();
}

function readCompression(value: number, label: string): Arq5Compression {
  if (value !== 0 && value !== 1 && value !== 2) {
    throw new ArchiveFormatError("unsupported_compression", `The Arq 5 ${label} uses unsupported compression type ${value}`);
  }
  return value;
}

function readUint32Count(reader: BinaryReader, label: string): number {
  const value = reader.readUint32();
  if (value > 10_000_000) throw new ArchiveFormatError("absurd_collection_size", `The Arq 5 tree has an invalid ${label} count`);
  return value;
}
