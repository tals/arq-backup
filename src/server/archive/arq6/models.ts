import { parseNode, type Arq7Node } from "../arq7/models";
import { ArchiveFormatError } from "../common/errors";

export type Arq6SnapshotVolume = {
  diskIdentifier: string;
  name: string;
  mountPoint: string;
  node: Arq7Node;
  isImportedFromArq5: boolean;
};

export type Arq6Snapshot = {
  planUUID: string;
  creationDate: number;
  isComplete: boolean;
  isImportedFromArq5: boolean;
  skippedNodeLessVolumes: number;
  volumes: Arq6SnapshotVolume[];
};

export function parseArq6Snapshot(bytes: Uint8Array): Arq6Snapshot {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    value = asObject(parsed, "snapshot");
  } catch (error) {
    if (error instanceof ArchiveFormatError) throw error;
    throw formatError("snapshot is not valid UTF-8 JSON");
  }

  const volumesByIdentifier = requiredObject(value, "snapshotVolumesByDiskIdentifier");
  let skippedNodeLessVolumes = 0;
  const volumes = Object.entries(volumesByIdentifier).flatMap(([identifier, candidate]) => {
    const volume = asObject(candidate, `snapshot volume ${identifier}`);
    if (volume.node == null) {
      skippedNodeLessVolumes += 1;
      return [];
    }
    const redundantIdentifier = optionalString(volume, "diskIdentifier", "");
    if (redundantIdentifier && redundantIdentifier !== identifier) {
      throw formatError(`snapshot volume ${identifier} has a mismatched disk identifier`);
    }
    return [{
      diskIdentifier: identifier,
      name: optionalString(volume, "name", ""),
      mountPoint: optionalString(volume, "mountPoint", ""),
      node: parseNode(requiredObject(volume, "node")),
      isImportedFromArq5: optionalBoolean(volume, "isImportedFromArq5", false),
    }];
  });

  return {
    planUUID: requiredString(value, "planUUID"),
    creationDate: requiredFiniteNumber(value, "creationDate"),
    isComplete: requiredBoolean(value, "isComplete"),
    isImportedFromArq5: optionalBoolean(value, "isImportedFromArq5", false),
    skippedNodeLessVolumes,
    volumes,
  };
}

function requiredObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return asObject(value[key], key);
}

function asObject(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw formatError(`${description} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string") throw formatError(`${key} must be a string`);
  return candidate;
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  const candidate = value[key];
  if (typeof candidate !== "boolean") throw formatError(`${key} must be a boolean`);
  return candidate;
}

function optionalString(value: Record<string, unknown>, key: string, fallback: string): string {
  const candidate = value[key];
  if (candidate == null) return fallback;
  if (typeof candidate !== "string") throw formatError(`${key} must be a string`);
  return candidate;
}

function optionalBoolean(value: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const candidate = value[key];
  if (candidate == null) return fallback;
  if (typeof candidate !== "boolean") throw formatError(`${key} must be a boolean`);
  return candidate;
}

function requiredFiniteNumber(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw formatError(`${key} must be a finite number`);
  }
  return candidate;
}

function formatError(detail: string): ArchiveFormatError {
  return new ArchiveFormatError("invalid_arq6_snapshot", `The experimental Arq 6 ${detail}`);
}
