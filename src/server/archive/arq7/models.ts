import { ArchiveFormatError } from "../common/errors";

export type Arq7BlobLocation = {
  blobIdentifier: string;
  isPacked: boolean;
  isLargePack: boolean;
  relativePath: string;
  offset: number;
  length: number;
  stretchEncryptionKey: boolean;
  compressionType: 0 | 1 | 2;
};

export type Arq7Node = {
  isTree: boolean;
  treeBlobLoc: Arq7BlobLocation | null;
  dataBlobLocs: Arq7BlobLocation[];
  itemSize: number;
  containedFilesCount: number;
  modificationTimeSeconds: number;
  modificationTimeNanoseconds: number;
  mode: number;
  deleted: boolean;
  isSparse: boolean;
  sparseLogicalSize: number;
};

export type Arq7BackupRecord = {
  backupFolderUUID: string;
  backupPlanUUID: string;
  creationDate: number;
  isComplete: boolean;
  localPath: string;
  volumeName: string | null;
  nodeTreeVersion: number;
  node: Arq7Node;
};

export function parseBackupRecord(bytes: Uint8Array): Arq7BackupRecord {
  const value = parseJsonObject(bytes, "backup record");
  return {
    backupFolderUUID: requiredString(value, "backupFolderUUID"),
    backupPlanUUID: requiredString(value, "backupPlanUUID"),
    creationDate: requiredSafeInteger(value, "creationDate"),
    isComplete: requiredBoolean(value, "isComplete"),
    localPath: requiredString(value, "localPath"),
    volumeName: optionalString(value, "volumeName"),
    nodeTreeVersion: requiredInteger(value, "nodeTreeVersion"),
    node: parseNode(requiredObject(value, "node")),
  };
}

export function parseNode(value: Record<string, unknown>): Arq7Node {
  const dataBlobLocs = requiredArray(value, "dataBlobLocs").map((item, index) =>
    parseBlobLocation(asObject(item, `dataBlobLocs[${index}]`))
  );
  const treeBlobLocValue = value.treeBlobLoc;
  return {
    isTree: requiredBoolean(value, "isTree"),
    treeBlobLoc: treeBlobLocValue == null ? null : parseBlobLocation(asObject(treeBlobLocValue, "treeBlobLoc")),
    dataBlobLocs,
    itemSize: requiredSafeInteger(value, "itemSize"),
    containedFilesCount: requiredSafeInteger(value, "containedFilesCount"),
    modificationTimeSeconds: requiredSafeInteger(value, "modificationTime_sec"),
    modificationTimeNanoseconds: requiredSafeInteger(value, "modificationTime_nsec"),
    mode: requiredSafeInteger(value, "mac_st_mode"),
    deleted: optionalBoolean(value, "deleted", false),
    isSparse: optionalBoolean(value, "isSparse", false),
    sparseLogicalSize: optionalSafeInteger(value, "sparseLogicalSize", 0),
  };
}

export function parseBlobLocation(value: Record<string, unknown>): Arq7BlobLocation {
  const compressionType = requiredInteger(value, "compressionType");
  if (compressionType !== 0 && compressionType !== 1 && compressionType !== 2) {
    throw formatError(`blob location has unsupported compression type ${compressionType}`);
  }
  return {
    blobIdentifier: requiredString(value, "blobIdentifier"),
    isPacked: requiredBoolean(value, "isPacked"),
    isLargePack: requiredBoolean(value, "isLargePack"),
    relativePath: requiredString(value, "relativePath"),
    offset: requiredSafeInteger(value, "offset"),
    length: requiredSafeInteger(value, "length"),
    stretchEncryptionKey: requiredBoolean(value, "stretchEncryptionKey"),
    compressionType,
  };
}

function parseJsonObject(bytes: Uint8Array, description: string): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return asObject(value, description);
  } catch (error) {
    if (error instanceof ArchiveFormatError) throw error;
    throw formatError(`${description} is not valid UTF-8 JSON`);
  }
}

function requiredObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return asObject(value[key], key);
}

function asObject(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw formatError(`${description} must be an object`);
  return value as Record<string, unknown>;
}

function requiredArray(value: Record<string, unknown>, key: string): unknown[] {
  const candidate = value[key];
  if (!Array.isArray(candidate)) throw formatError(`${key} must be an array`);
  return candidate;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string") throw formatError(`${key} must be a string`);
  return candidate;
}

function optionalString(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  if (candidate == null) return null;
  if (typeof candidate !== "string") throw formatError(`${key} must be a string or null`);
  return candidate;
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  const candidate = value[key];
  if (typeof candidate !== "boolean") throw formatError(`${key} must be a boolean`);
  return candidate;
}

function optionalBoolean(value: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const candidate = value[key];
  if (candidate == null) return fallback;
  if (typeof candidate !== "boolean") throw formatError(`${key} must be a boolean`);
  return candidate;
}

function optionalSafeInteger(value: Record<string, unknown>, key: string, fallback: number): number {
  const candidate = value[key];
  if (candidate == null) return fallback;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
    throw formatError(`${key} must be a non-negative safe integer`);
  }
  return candidate;
}

function requiredInteger(value: Record<string, unknown>, key: string): number {
  const candidate = requiredSafeInteger(value, key);
  if (!Number.isInteger(candidate)) throw formatError(`${key} must be an integer`);
  return candidate;
}

function requiredSafeInteger(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
    throw formatError(`${key} must be a non-negative safe integer`);
  }
  return candidate;
}

function formatError(detail: string): ArchiveFormatError {
  return new ArchiveFormatError("invalid_arq7_record", `The Arq 7 ${detail}`);
}
