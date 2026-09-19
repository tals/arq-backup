import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { lstat, lutimes, open, readlink, symlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RestoreItemDescriptor, RestoreSource } from "./source";

const DEFAULT_FILE_PERMISSIONS = 0o644;
const DEFAULT_DIRECTORY_PERMISSIONS = 0o755;

export class RestoreCanceledError extends Error {
  constructor() {
    super("Restore canceled");
    this.name = "RestoreCanceledError";
  }
}

export type MaterializeCallbacks = {
  canceled(): boolean;
  onBytes(bytes: number): void;
  beforeCommit?(): void;
};

export type MaterializeResult = { skipped: boolean };

export type RestoreDirectoryPreparation = { previousMode: number | null };

export function chmodModeSync(path: string, mode: number): void {
  const restorableMode = mode & 0o7777;
  if ((restorableMode & 0o7000) === 0) {
    chmodSync(path, restorableMode);
    return;
  }

  // Bun's node:fs chmod compatibility currently drops special mode bits on
  // macOS. Use the native utility only when those bits must be preserved.
  const result = Bun.spawnSync({
    cmd: ["/bin/chmod", restorableMode.toString(8).padStart(4, "0"), path],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.success) return;
  const detail = new TextDecoder().decode(result.stderr).trim();
  throw new Error(`Failed to apply mode ${restorableMode.toString(8)} to ${path}: ${detail || `chmod exited ${result.exitCode}`}`);
}

function lchmodModeSync(path: string, mode: number): void {
  const restorableMode = mode & 0o7777;
  const result = Bun.spawnSync({
    cmd: ["/bin/chmod", "-h", restorableMode.toString(8).padStart(4, "0"), path],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.success) return;
  const detail = new TextDecoder().decode(result.stderr).trim();
  throw new Error(`Failed to apply symlink mode ${restorableMode.toString(8)} to ${path}: ${detail || `chmod exited ${result.exitCode}`}`);
}

export function ensureRestoreDirectory(
  path: string,
  temporarilyWritable = false,
): RestoreDirectoryPreparation {
  let previousMode: number | null = null;
  try {
    const previous = lstatSync(path);
    if (!previous.isDirectory()) throw new Error(`Restore path is not a directory: ${path}`);
    previousMode = previous.mode & 0o7777;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const value = lstatSync(path);
  if (!value.isDirectory()) throw new Error(`Restore path is not a directory: ${path}`);
  if (temporarilyWritable) chmodModeSync(path, (value.mode & 0o7777) | 0o700);
  return { previousMode };
}

export async function finalizeRestoreDirectory(path: string, item: RestoreItemDescriptor): Promise<void> {
  const value = await lstat(path);
  if (!value.isDirectory()) throw new Error(`Restore path changed from a directory: ${path}`);
  const modified = modifiedTimeSeconds(item);
  await utimes(path, modified, modified);
  chmodModeSync(path, restorePermissions(item));
}

export async function materializeRegularFile(
  source: RestoreSource,
  token: string,
  path: string,
  item: RestoreItemDescriptor,
  callbacks: MaterializeCallbacks,
  requireExactSkip = false,
): Promise<MaterializeResult> {
  await ensureRestoreDirectory(dirname(path));
  const destination = await lstatIfExists(path);
  if (destination && !destination.isFile()) throw new Error(`File restore conflicts with a non-file destination: ${path}`);
  const exactDestination = destination
    && destination.size === item.entry.size
    && sameModifiedTime(path, item);
  if (requireExactSkip && !exactDestination) {
    throw new Error(`Restore destination changed after its exact size-and-timestamp skip was reserved: ${path}`);
  }
  if (exactDestination) {
    if (callbacks.canceled()) throw new RestoreCanceledError();
    callbacks.beforeCommit?.();
    chmodModeSync(path, restorePermissions(item));
    callbacks.onBytes(item.entry.size);
    return { skipped: true };
  }

  const partialPath = partialFilePath(path, item.identity);
  let partial = await lstatIfExists(partialPath);
  if (partial && !partial.isFile()) throw new Error(`Retained Partial File is not a regular file: ${partialPath}`);
  if (!partial) {
    const created = await open(partialPath, "ax", 0o600);
    await created.close();
    partial = await lstat(partialPath);
  }
  if (partial.size > item.entry.size) {
    throw new Error(`Retained Partial File is ${partial.size} bytes, larger than the archived ${item.entry.size} bytes: ${partialPath}`);
  }
  callbacks.onBytes(partial.size);

  const retainedSize = partial.size;
  chmodModeSync(partialPath, (partial.mode & 0o7777) | 0o600);
  const output = await open(partialPath, "r+");
  let sourceOffset = 0;
  let wroteData = false;
  try {
    for await (const chunk of source.readData(token)) {
      try {
        if (callbacks.canceled()) throw new RestoreCanceledError();
        const chunkEnd = sourceOffset + chunk.byteLength;
        if (!Number.isSafeInteger(chunkEnd) || chunkEnd > item.entry.size) {
          throw new Error(`Archived data exceeds the declared ${item.entry.size}-byte file size: ${path}`);
        }

        const retainedEnd = Math.min(chunkEnd, retainedSize);
        if (retainedEnd > sourceOffset) {
          const retainedLength = retainedEnd - sourceOffset;
          const retained = Buffer.allocUnsafe(retainedLength);
          try {
            await readFully(output, retained, sourceOffset);
            if (!retained.equals(chunk.subarray(0, retainedLength))) {
              throw new Error(`Retained Partial File differs from the archived data at byte ${sourceOffset}: ${partialPath}`);
            }
          } finally {
            retained.fill(0);
          }
        }

        if (retainedSize < chunkEnd) {
          const chunkOffset = Math.max(0, retainedSize - sourceOffset);
          const writePosition = sourceOffset + chunkOffset;
          await writeFully(output, chunk.subarray(chunkOffset), writePosition, callbacks);
          const added = chunk.byteLength - chunkOffset;
          callbacks.onBytes(added);
          wroteData = true;
        }
        sourceOffset = chunkEnd;
      } finally {
        chunk.fill(0);
      }
    }
    if (sourceOffset !== item.entry.size) {
      throw new Error(`Archived data produced ${sourceOffset} bytes, expected ${item.entry.size}: ${path}`);
    }
    if (wroteData) await output.sync();
  } finally {
    await output.close();
  }

  const completed = await lstat(partialPath);
  if (!completed.isFile() || completed.size !== item.entry.size) {
    throw new Error(`Partial File ended at ${completed.size} bytes, expected ${item.entry.size}: ${partialPath}`);
  }
  if (callbacks.canceled()) throw new RestoreCanceledError();
  const modified = modifiedTimeSeconds(item);
  await utimes(partialPath, modified, modified);
  if (callbacks.canceled()) throw new RestoreCanceledError();
  chmodModeSync(partialPath, restorePermissions(item));
  if (callbacks.canceled()) throw new RestoreCanceledError();
  callbacks.beforeCommit?.();
  renameSync(partialPath, path);
  return { skipped: false };
}

export function regularFileMatchesDestination(path: string, item: RestoreItemDescriptor): boolean {
  try {
    const destination = lstatSync(path);
    return destination.isFile()
      && destination.size === item.entry.size
      && sameModifiedTime(path, item);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function materializeSymlink(
  source: RestoreSource,
  token: string,
  path: string,
  item: RestoreItemDescriptor,
  callbacks: MaterializeCallbacks,
): Promise<MaterializeResult> {
  await ensureRestoreDirectory(dirname(path));
  const destination = await lstatIfExists(path);
  if (destination && !destination.isSymbolicLink()) throw new Error(`Symlink restore conflicts with a non-symlink destination: ${path}`);

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of source.readData(token)) {
      try {
        if (callbacks.canceled()) throw new RestoreCanceledError();
        size += chunk.byteLength;
        if (!Number.isSafeInteger(size) || size > item.entry.size) {
          throw new Error(`Archived symlink data exceeds its declared ${item.entry.size}-byte size: ${path}`);
        }
        chunks.push(Buffer.from(chunk));
        callbacks.onBytes(chunk.byteLength);
      } finally {
        chunk.fill(0);
      }
    }
    if (size !== item.entry.size) throw new Error(`Archived symlink data produced ${size} bytes, expected ${item.entry.size}: ${path}`);
    const target = Buffer.concat(chunks);
    try {
      if (destination && sameModifiedTime(path, item)) {
        const existingTarget = await readlink(path, { encoding: "buffer" });
        try {
          if (existingTarget.equals(target)) {
            if (callbacks.canceled()) throw new RestoreCanceledError();
            callbacks.beforeCommit?.();
            lchmodModeSync(path, restorePermissions(item));
            return { skipped: true };
          }
        } finally {
          existingTarget.fill(0);
        }
      }

      const partialPath = partialFilePath(path, item.identity);
      const partial = await lstatIfExists(partialPath);
      if (partial) {
        if (!partial.isSymbolicLink()) throw new Error(`Retained Partial Symlink is not a symlink: ${partialPath}`);
        const existingTarget = await readlink(partialPath, { encoding: "buffer" });
        try {
          if (!existingTarget.equals(target)) throw new Error(`Retained Partial Symlink has a different target: ${partialPath}`);
        } finally {
          existingTarget.fill(0);
        }
      } else {
        await symlink(target, partialPath);
      }
      if (callbacks.canceled()) throw new RestoreCanceledError();
      const modified = modifiedTimeSeconds(item);
      await lutimes(partialPath, modified, modified);
      if (callbacks.canceled()) throw new RestoreCanceledError();
      lchmodModeSync(partialPath, restorePermissions(item));
      if (callbacks.canceled()) throw new RestoreCanceledError();
      callbacks.beforeCommit?.();
      renameSync(partialPath, path);
      return { skipped: false };
    } finally {
      target.fill(0);
    }
  } finally {
    chunks.forEach(chunk => chunk.fill(0));
  }
}

export function partialFilePath(path: string, identity: string): string {
  const digest = createHash("sha256").update(identity).update("\0").update(path).digest("hex");
  return join(dirname(path), `.arq-restore-${digest}.partial`);
}

function restorePermissions(item: RestoreItemDescriptor): number {
  if (item.entry.mode === 0) {
    return item.entry.kind === "folder" ? DEFAULT_DIRECTORY_PERMISSIONS : DEFAULT_FILE_PERMISSIONS;
  }
  return item.entry.mode & 0o7777;
}

async function writeFully(
  output: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
  position: number,
  callbacks: MaterializeCallbacks,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (callbacks.canceled()) throw new RestoreCanceledError();
    const { bytesWritten } = await output.write(bytes, offset, bytes.byteLength - offset, position + offset);
    if (bytesWritten <= 0) throw new Error("Writing the Partial File made no progress");
    offset += bytesWritten;
  }
}

async function readFully(
  input: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await input.read(bytes, offset, bytes.byteLength - offset, position + offset);
    if (bytesRead <= 0) throw new Error(`Retained Partial File ended unexpectedly at byte ${position + offset}`);
    offset += bytesRead;
  }
}

function modifiedTimeSeconds(item: RestoreItemDescriptor): number {
  if (!Number.isSafeInteger(item.modifiedSeconds)
    || !Number.isInteger(item.modifiedNanoseconds)
    || item.modifiedNanoseconds < 0
    || item.modifiedNanoseconds >= 1_000_000_000) {
    throw new Error(`Archived modification time is invalid for ${item.entry.name}`);
  }
  const value = item.modifiedSeconds + item.modifiedNanoseconds / 1_000_000_000;
  if (!Number.isFinite(value)) throw new Error(`Archived modification time is invalid for ${item.entry.name}`);
  return value;
}

function sameModifiedTime(path: string, item: RestoreItemDescriptor): boolean {
  const actual = lstatSync(path, { bigint: true }).mtimeNs;
  const archived = BigInt(item.modifiedSeconds) * 1_000_000_000n + BigInt(item.modifiedNanoseconds);
  if (actual === archived) return true;

  // node:fs accepts fractional seconds but represents them as a JavaScript number.
  // Accept the exact nanoseconds that the same API can materialize on this platform.
  const applied = modifiedTimeSeconds(item);
  const wholeSeconds = Math.trunc(applied);
  const fractionalNanoseconds = Math.trunc((applied - wholeSeconds) * 1_000_000_000);
  const materialized = BigInt(wholeSeconds) * 1_000_000_000n + BigInt(fractionalNanoseconds);
  return actual === materialized;
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
