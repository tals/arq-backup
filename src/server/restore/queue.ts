import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ArchiveEntrySummary,
  RestoreJobSummary,
  RestoreQueueSnapshot,
} from "../../shared/contracts";
import type { ArchiveSessionLease, ArchiveSessionStore } from "../archive/arq7/session-store";
import { ArchiveFormatError } from "../archive/common/errors";
import {
  chmodModeSync,
  ensureRestoreDirectory,
  finalizeRestoreDirectory,
  materializeRegularFile,
  materializeSymlink,
  partialFilePath,
  regularFileMatchesDestination,
  RestoreCanceledError,
} from "./materializer";
import type { RestoreItemDescriptor } from "./source";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 32;
const MAX_RESTORE_DEPTH = 1_024;

type DirectoryItem = { path: string; item: RestoreItemDescriptor };
type PreparedDirectoryItem = DirectoryItem & { previousMode: number | null };
type DataItem = { token: string; path: string; item: RestoreItemDescriptor };
type WorkItem =
  | { kind: "expand"; jobId: string; token: string; path: string }
  | { kind: "prepare"; jobId: string; directories: DirectoryItem[]; dataItems: DataItem[] }
  | { kind: "data"; jobId: string; data: DataItem };

type PathReservation = {
  jobId: string;
  path: string;
  comparisonPath: string;
  subtree: boolean;
  global: boolean;
  persistent: boolean;
};

type PartialClaim = {
  identity: string;
  destinationPath: string;
  readOnlyExactSkip: boolean;
};

type FinalClaim = PartialClaim & {
  inode: string;
};

type FileIdentity = {
  inode: string;
  links: bigint;
};

type MaterializationClaim = {
  partialPath: string;
  partialKey: string;
  destinationKey: string;
  owner: PartialClaim;
  activeInodes: string[];
  activePathKeys: string[];
};

export type RestoreQueueOperations = {
  finalizeDirectory(path: string, item: RestoreItemDescriptor): Promise<void>;
};

const DEFAULT_OPERATIONS: RestoreQueueOperations = {
  finalizeDirectory: finalizeRestoreDirectory,
};

type RestoreJob = {
  summary: RestoreJobSummary;
  lease: ArchiveSessionLease;
  remainingWork: number;
  directories: PreparedDirectoryItem[];
  reservations: PathReservation[];
  finalizing: boolean;
  released: boolean;
};

export class RestoreQueue {
  readonly #jobs = new Map<string, RestoreJob>();
  readonly #pending: WorkItem[] = [];
  readonly #reservations = new Set<PathReservation>();
  readonly #partialClaims = new Map<string, PartialClaim>();
  readonly #activeInodeClaims = new Map<string, Map<string, PartialClaim>>();
  readonly #activePathClaims = new Map<string, PartialClaim>();
  readonly #finalClaimsByPath = new Map<string, FinalClaim>();
  readonly #finalClaimsByInode = new Map<string, Map<string, FinalClaim>>();
  #concurrency = DEFAULT_CONCURRENCY;
  #activeWorkers = 0;
  #destroyed = false;
  #shutdownPromise: Promise<void> | null = null;
  #resolveShutdown: (() => void) | null = null;

  constructor(
    readonly sessions: ArchiveSessionStore,
    readonly operations: RestoreQueueOperations = DEFAULT_OPERATIONS,
  ) {}

  snapshot(): RestoreQueueSnapshot {
    return {
      concurrency: this.#concurrency,
      activeWorkers: this.#activeWorkers,
      jobs: [...this.#jobs.values()]
        .map(job => structuredClone(job.summary))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    };
  }

  setConcurrency(value: number): RestoreQueueSnapshot {
    if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
      throw new ArchiveFormatError("invalid_concurrency", "Restore concurrency must be an integer from 1 through 32");
    }
    this.#concurrency = value;
    this.#pump();
    return this.snapshot();
  }

  enqueue(
    sessionId: string,
    token: string,
    destinationDirectory: string,
    relativePath?: string,
  ): RestoreJobSummary {
    if (this.#destroyed) throw new ArchiveFormatError("restore_queue_stopped", "The Restore Queue has stopped");
    if (!isAbsolute(destinationDirectory)) {
      throw new ArchiveFormatError("invalid_destination", "Choose an absolute local destination directory");
    }
    const lease = this.sessions.acquire(sessionId);
    if (!lease) throw new ArchiveFormatError("missing_session", "This archive is locked or the server restarted");
    try {
      const item = lease.repository.describeRestoreItem(token);
      const destinationPath = resolveRestoreDestination(
        destinationDirectory,
        relativePath ?? item.entry.name,
        item.entry.name,
      );
      const id = randomUUID();
      const summary: RestoreJobSummary = {
        id,
        name: item.entry.name,
        kind: item.entry.kind,
        destinationPath,
        state: "queued",
        totalFiles: item.entry.kind === "folder" ? 0 : 1,
        completedFiles: 0,
        skippedFiles: 0,
        totalBytes: item.entry.kind === "folder" ? 0 : item.entry.size,
        completedBytes: 0,
        currentPath: null,
        error: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
      };
      const job: RestoreJob = {
        summary,
        lease,
        remainingWork: 1,
        directories: [],
        reservations: [],
        finalizing: false,
        released: false,
      };
      this.#jobs.set(id, job);
      this.#pending.push(item.entry.kind === "folder"
        ? { kind: "expand", jobId: id, token, path: destinationPath }
        : { kind: "data", jobId: id, data: { token, path: destinationPath, item } });
      this.#pump();
      return structuredClone(summary);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  cancel(jobId: string): RestoreQueueSnapshot {
    const job = this.#jobs.get(jobId);
    if (!job) throw new ArchiveFormatError("missing_restore_job", "Restore Job not found");
    if (isTerminal(job.summary.state)) return this.snapshot();
    job.summary.state = "canceled";
    job.summary.currentPath = null;
    job.summary.finishedAt = new Date().toISOString();
    this.#dropPending(job);
    void this.#finishIfDone(job);
    return this.snapshot();
  }

  destroy(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownPromise = new Promise<void>(resolve => this.#resolveShutdown = resolve);
    this.#destroyed = true;
    for (const job of this.#jobs.values()) {
      if (job.released) continue;
      if (!isTerminal(job.summary.state)) {
        job.summary.state = "canceled";
        job.summary.currentPath = null;
        job.summary.finishedAt = new Date().toISOString();
      }
      this.#dropPending(job);
      void this.#finishIfDone(job);
    }
    this.#maybeResolveShutdown();
    return this.#shutdownPromise;
  }

  #pump(): void {
    while (!this.#destroyed && this.#activeWorkers < this.#concurrency && this.#pending.length > 0) {
      const pendingIndex = this.#pending.findIndex(work => this.#canReserve(work));
      if (pendingIndex < 0) return;
      const [work] = this.#pending.splice(pendingIndex, 1) as [WorkItem];
      const reservations = this.#reserve(work);
      this.#activeWorkers += 1;
      void this.#run(work).finally(() => {
        for (const reservation of reservations) this.#reservations.delete(reservation);
        this.#activeWorkers -= 1;
        this.#pump();
        this.#maybeResolveShutdown();
      });
    }
  }

  async #run(work: WorkItem): Promise<void> {
    const job = this.#jobs.get(work.jobId);
    if (!job) return;
    try {
      if (isTerminal(job.summary.state)) return;
      if (work.kind === "expand") await this.#expand(job, work.token, work.path);
      else if (work.kind === "prepare") await this.#prepare(job, work.directories, work.dataItems);
      else await this.#materialize(job, work.data);
    } catch (error) {
      if (error instanceof RestoreCanceledError && job.summary.state === "canceled") return;
      const errorPath = work.kind === "data"
        ? work.data.path
        : job.summary.currentPath ?? workErrorPath(work, job.summary.destinationPath);
      this.#fail(job, errorPath, error);
    } finally {
      job.remainingWork -= 1;
      await this.#finishIfDone(job);
    }
  }

  async #expand(job: RestoreJob, token: string, path: string): Promise<void> {
    job.summary.state = "expanding";
    job.summary.currentPath = path;
    const directories: DirectoryItem[] = [];
    const dataItems: DataItem[] = [];
    await this.#discoverFolder(job, token, path, 0, directories, dataItems);
    if (jobCanceled(job)) throw new RestoreCanceledError();
    job.remainingWork += 1;
    this.#pending.push({ kind: "prepare", jobId: job.summary.id, directories, dataItems });
    job.summary.state = "queued";
    job.summary.currentPath = null;
    this.#pump();
  }

  async #discoverFolder(
    job: RestoreJob,
    token: string,
    path: string,
    depth: number,
    directories: DirectoryItem[],
    dataItems: DataItem[],
  ): Promise<void> {
    if (jobCanceled(job)) throw new RestoreCanceledError();
    if (depth > MAX_RESTORE_DEPTH) throw new Error(`Restore folder depth exceeds ${MAX_RESTORE_DEPTH}: ${path}`);
    job.summary.currentPath = path;
    const children = await job.lease.repository.listChildren(token);
    if (jobCanceled(job)) throw new RestoreCanceledError();
    const directory = job.lease.repository.describeRestoreItem(token);
    directories.push({ path, item: directory });
    for (const child of children) {
      if (jobCanceled(job)) throw new RestoreCanceledError();
      const item = job.lease.repository.describeRestoreItem(child.token);
      const childPath = resolve(path, item.entry.name);
      if (item.entry.kind === "folder") {
        await this.#discoverFolder(job, child.token, childPath, depth + 1, directories, dataItems);
      } else {
        dataItems.push({ token: child.token, path: childPath, item });
        job.summary.totalFiles += 1;
        job.summary.totalBytes += item.entry.size;
        if (!Number.isSafeInteger(job.summary.totalBytes)) throw new Error(`Restore byte count is too large: ${path}`);
      }
    }
  }

  async #prepare(job: RestoreJob, directories: DirectoryItem[], dataItems: DataItem[]): Promise<void> {
    job.summary.state = "expanding";
    const directoryInodes = new Map<string, PreparedDirectoryItem>();
    for (const directory of directories) {
      if (jobCanceled(job)) throw new RestoreCanceledError();
      job.summary.currentPath = directory.path;
      const preparation = ensureRestoreDirectory(directory.path, true);
      const prepared = { ...directory, previousMode: preparation.previousMode };
      const value = lstatSync(directory.path, { bigint: true });
      const inode = `${value.dev}:${value.ino}`;
      const alias = directoryInodes.get(inode);
      if (alias) {
        throw new Error(`Restore directories resolve to the same destination inode (${alias.path}): ${directory.path}`);
      }
      directoryInodes.set(inode, prepared);
      job.directories.push(prepared);
      if (jobCanceled(job)) throw new RestoreCanceledError();
    }
    job.remainingWork += dataItems.length;
    for (const data of dataItems) this.#pending.push({ kind: "data", jobId: job.summary.id, data });
    job.summary.state = dataItems.length > 0 ? "running" : "queued";
    job.summary.currentPath = null;
    this.#pump();
  }

  async #materialize(job: RestoreJob, data: DataItem): Promise<void> {
    job.summary.state = "running";
    job.summary.currentPath = data.path;
    const claim = await this.#claimPartial(data);
    const callbacks = {
      canceled: () => isTerminal(job.summary.state) || this.#destroyed,
      onBytes: (bytes: number) => {
        job.summary.completedBytes += bytes;
      },
      beforeCommit: () => {
        if (claimPathKey(canonicalRestorePath(data.path)) !== claim.destinationKey) {
          throw new Error(`Restore destination resolved to a different filesystem path before commit: ${data.path}`);
        }
      },
    };
    try {
      const result = data.item.entry.kind === "symlink"
        ? await materializeSymlink(job.lease.repository, data.token, data.path, data.item, callbacks)
        : await materializeRegularFile(
          job.lease.repository,
          data.token,
          data.path,
          data.item,
          callbacks,
          claim.owner.readOnlyExactSkip,
        );
      if (callbacks.canceled()) throw new RestoreCanceledError();
      await this.#recordFinalClaim(data, claim);
      if (callbacks.canceled()) throw new RestoreCanceledError();
      this.#releasePartialClaim(claim);
      job.summary.completedFiles += 1;
      if (result.skipped) job.summary.skippedFiles += 1;
    } catch (error) {
      if (!await pathExists(claim.partialPath)) this.#releasePartialClaim(claim);
      throw error;
    } finally {
      this.#releaseActiveInodeClaims(claim);
      this.#releaseActivePathClaims(claim);
    }
  }

  async #finishIfDone(job: RestoreJob): Promise<void> {
    if (job.remainingWork !== 0 || job.finalizing) return;
    job.finalizing = true;
    try {
      if (!isTerminal(job.summary.state)) {
        try {
          for (const directory of directoriesByFilesystemDepth(job.directories, true)) {
            if (isTerminal(job.summary.state)) break;
            job.summary.currentPath = directory.path;
            await this.operations.finalizeDirectory(directory.path, directory.item);
            if (isTerminal(job.summary.state)) break;
          }
          if (!isTerminal(job.summary.state)) job.summary.state = "completed";
        } catch (error) {
          this.#fail(job, job.summary.currentPath ?? job.summary.destinationPath, error);
        }
      }
      if (job.summary.state !== "completed") this.#rollbackDirectoryModes(job);
      job.summary.currentPath = null;
      job.summary.finishedAt ??= new Date().toISOString();
      this.#release(job);
    } finally {
      job.finalizing = false;
    }
  }

  #fail(job: RestoreJob, path: string, error: unknown): void {
    if (isTerminal(job.summary.state)) return;
    job.summary.state = "failed";
    job.summary.error = {
      path,
      message: error instanceof Error ? error.message : "Unknown Restore error",
    };
    job.summary.currentPath = null;
    job.summary.finishedAt = new Date().toISOString();
    this.#dropPending(job);
  }

  #dropPending(job: RestoreJob): void {
    let removed = 0;
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      if (this.#pending[index]!.jobId !== job.summary.id) continue;
      this.#pending.splice(index, 1);
      removed += 1;
    }
    job.remainingWork -= removed;
  }

  #rollbackDirectoryModes(job: RestoreJob): void {
    // Finalization may already have applied a non-traversable archived mode to
    // an ancestor. Open ancestors first so descendant modes can be restored.
    for (const directory of directoriesByFilesystemDepth(job.directories, false)) {
      if (directory.previousMode === null) continue;
      try {
        const value = lstatSync(directory.path);
        if (!value.isDirectory()) throw new Error(`Restore path changed from a directory: ${directory.path}`);
        chmodModeSync(directory.path, (value.mode & 0o7777) | 0o700);
      } catch (error) {
        this.#recordDirectoryRollbackFailure(job, directory.path, "make the directory traversable", error);
      }
    }

    for (const directory of directoriesByFilesystemDepth(job.directories, true)) {
      if (directory.previousMode === null) continue;
      try {
        const value = lstatSync(directory.path);
        if (!value.isDirectory()) throw new Error(`Restore path changed from a directory: ${directory.path}`);
        chmodModeSync(directory.path, directory.previousMode);
      } catch (error) {
        this.#recordDirectoryRollbackFailure(job, directory.path, "restore the prior directory mode", error);
      }
    }
  }

  #recordDirectoryRollbackFailure(job: RestoreJob, path: string, action: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : "Unknown directory-mode rollback error";
    const message = `Failed to ${action}: ${detail}`;
    if (job.summary.error) job.summary.error.message = `${job.summary.error.message}; ${message}`;
    else job.summary.error = { path, message };
    job.summary.state = "failed";
  }

  #canReserve(work: WorkItem): boolean {
    for (const candidate of workReservations(work)) {
      for (const reservation of this.#reservations) {
        if (reservation.jobId === work.jobId && reservation.persistent) continue;
        if (reservationsConflict(candidate, reservation)) return false;
      }
    }
    return true;
  }

  #reserve(work: WorkItem): PathReservation[] {
    const persistent = work.kind === "prepare";
    const reservations = workReservations(work).map(candidate => ({
      ...candidate,
      jobId: work.jobId,
      persistent,
    }));
    for (const reservation of reservations) this.#reservations.add(reservation);
    if (!persistent) return reservations;

    const job = this.#jobs.get(work.jobId);
    if (!job) throw new Error(`Restore Job disappeared before its paths could be reserved: ${work.jobId}`);
    job.reservations.push(...reservations);
    return [];
  }

  async #claimPartial(data: DataItem): Promise<MaterializationClaim> {
    ensureRestoreDirectory(dirname(data.path));
    const owner: PartialClaim = {
      identity: data.item.identity,
      destinationPath: data.path,
      readOnlyExactSkip: data.item.entry.kind === "file"
        && regularFileMatchesDestination(data.path, data.item),
    };
    const partialPath = partialFilePath(data.path, data.item.identity);
    const destinationKey = claimPathKey(canonicalRestorePath(data.path));
    const partialKey = claimPathKey(canonicalRestorePath(partialPath));
    const activePathKeys = owner.readOnlyExactSkip
      ? [destinationKey]
      : [...new Set([destinationKey, partialKey])];
    for (const key of activePathKeys) {
      const active = this.#activePathClaims.get(key);
      if (active) {
        throw new Error(`Restore path is a filesystem alias of another active Restore item (${active.destinationPath}): ${data.path}`);
      }
    }
    for (const key of activePathKeys) this.#activePathClaims.set(key, owner);

    try {
      const destinationClaim = this.#partialClaims.get(destinationKey);
      if (destinationClaim && !samePartialClaim(destinationClaim, owner)) {
        throw new Error(`Restore destination conflicts with a retained Partial File from another item: ${data.path}`);
      }
      const destinationIdentity = await fileIdentityIfExists(data.path);
      const aliasedDestinations = destinationIdentity
        ? [...(this.#finalClaimsByInode.get(destinationIdentity.inode)?.entries() ?? [])]
          .map(([key, claim]) => ({ key, claim }))
        : [];
      const conflictingDestination = aliasedDestinations.find(({ key, claim }) => {
        if (key === destinationKey) {
          if (claim.destinationPath !== data.path) {
            const safeDistinctExactAliases = data.item.entry.kind === "file"
              && owner.readOnlyExactSkip
              && claim.identity === owner.identity
              && areDistinctCaseSensitiveEntries(claim.destinationPath, data.path);
            if (!safeDistinctExactAliases) return true;
          }
          return (data.item.entry.kind === "symlink" || owner.readOnlyExactSkip)
            && claim.identity !== owner.identity;
        }
        return data.item.entry.kind === "symlink"
          || (owner.readOnlyExactSkip && claim.identity !== owner.identity);
      })?.claim;
      if (conflictingDestination) {
        throw new Error(
          `Restore destination is a filesystem alias of another restored item (${conflictingDestination.destinationPath}): ${data.path}`,
        );
      }

      let partialIdentity: FileIdentity | null = null;
      if (!owner.readOnlyExactSkip) {
        const completedClaim = this.#finalClaimsByPath.get(partialKey);
        if (completedClaim && !samePartialClaim(completedClaim, owner)) {
          throw new Error(`Partial File path conflicts with another completed restore item: ${partialPath}`);
        }
        partialIdentity = await fileIdentityIfExists(partialPath);
        const aliasedPartial = partialIdentity
          ? [...(this.#finalClaimsByInode.get(partialIdentity.inode)?.values() ?? [])]
            .find(claim => !samePartialClaim(claim, owner))
          : null;
        if (aliasedPartial && !samePartialClaim(aliasedPartial, owner)) {
          throw new Error(`Partial File path is a filesystem alias of another completed restore item: ${partialPath}`);
        }
        if (destinationIdentity && partialIdentity && destinationIdentity.inode === partialIdentity.inode) {
          throw new Error(`Retained Partial File is a hard link to its Restore destination: ${partialPath}`);
        }
        if (partialIdentity && partialIdentity.links > 1n) {
          throw new Error(`Retained Partial File has ${partialIdentity.links} hard links and cannot be resumed safely: ${partialPath}`);
        }

        const existingClaim = this.#partialClaims.get(partialKey);
        if (existingClaim && !samePartialClaim(existingClaim, owner)) {
          throw new Error(`Partial File path conflicts with another restore item: ${partialPath}`);
        }
      }
      const activeInodes = [...new Set(
        [
          owner.readOnlyExactSkip || data.item.entry.kind === "symlink" ? destinationIdentity?.inode : undefined,
          owner.readOnlyExactSkip ? undefined : partialIdentity?.inode,
        ].filter((inode): inode is string => inode !== undefined),
      )];
      for (const inode of activeInodes) {
        const active = this.#activeInodeClaims.get(inode);
        if (active && [...active.values()].some(claim => !claimsCanShareInode(claim, owner))) {
          throw new Error(`Restore path is hard-linked to another active Restore item: ${data.path}`);
        }
      }

      if (!owner.readOnlyExactSkip) this.#partialClaims.set(partialKey, owner);
      for (const inode of activeInodes) {
        const claims = this.#activeInodeClaims.get(inode) ?? new Map<string, PartialClaim>();
        claims.set(destinationKey, owner);
        this.#activeInodeClaims.set(inode, claims);
      }
      return { partialPath, partialKey, destinationKey, owner, activeInodes, activePathKeys };
    } catch (error) {
      for (const key of activePathKeys) {
        if (this.#activePathClaims.get(key) === owner) this.#activePathClaims.delete(key);
      }
      throw error;
    }
  }

  #releasePartialClaim(claim: MaterializationClaim): void {
    const existing = this.#partialClaims.get(claim.partialKey);
    if (!existing || !samePartialClaim(existing, claim.owner)) return;
    this.#partialClaims.delete(claim.partialKey);
  }

  #releaseActiveInodeClaims(claim: MaterializationClaim): void {
    for (const inode of claim.activeInodes) {
      const claims = this.#activeInodeClaims.get(inode);
      if (!claims || claims.get(claim.destinationKey) !== claim.owner) continue;
      claims.delete(claim.destinationKey);
      if (claims.size === 0) this.#activeInodeClaims.delete(inode);
    }
  }

  #releaseActivePathClaims(claim: MaterializationClaim): void {
    for (const key of claim.activePathKeys) {
      if (this.#activePathClaims.get(key) === claim.owner) this.#activePathClaims.delete(key);
    }
  }

  async #recordFinalClaim(data: DataItem, materialization: MaterializationClaim): Promise<void> {
    const identity = await fileIdentityIfExists(data.path);
    if (!identity) throw new Error(`Restored output disappeared before completion could be recorded: ${data.path}`);
    const claim: FinalClaim = {
      identity: data.item.identity,
      destinationPath: data.path,
      readOnlyExactSkip: materialization.owner.readOnlyExactSkip,
      inode: identity.inode,
    };
    this.#finalClaimsByPath.set(materialization.destinationKey, claim);
    // Keep old inode claims for the lifetime of the queue. Replacing one path
    // cannot prove that an untracked hard-link name no longer reaches the old
    // inode, and case-folded path keys may represent distinct names on a
    // case-sensitive filesystem.
    const inodeClaims = this.#finalClaimsByInode.get(identity.inode) ?? new Map<string, FinalClaim>();
    inodeClaims.set(materialization.destinationKey, claim);
    this.#finalClaimsByInode.set(identity.inode, inodeClaims);
  }

  #release(job: RestoreJob): void {
    if (job.released) return;
    job.released = true;
    for (const reservation of job.reservations) this.#reservations.delete(reservation);
    job.reservations.length = 0;
    job.lease.release();
    this.#pump();
    this.#maybeResolveShutdown();
  }

  #maybeResolveShutdown(): void {
    if (!this.#destroyed || this.#activeWorkers !== 0) return;
    if ([...this.#jobs.values()].some(job => !job.released)) return;
    const resolve = this.#resolveShutdown;
    this.#resolveShutdown = null;
    resolve?.();
  }
}

function resolveRestoreDestination(
  destinationDirectory: string,
  relativePath: string,
  entryName: string,
): string {
  if (!relativePath || isAbsolute(relativePath)) {
    throw new ArchiveFormatError("invalid_restore_path", "The Restore path must be relative to the selected destination");
  }
  const components = relativePath.split(sep);
  if (components.some(component => !component || component === "." || component === "..")) {
    throw new ArchiveFormatError("invalid_restore_path", "The Restore path must stay within the selected destination");
  }

  const destinationRoot = resolve(destinationDirectory);
  const destinationPath = resolve(destinationRoot, relativePath);
  const scopedPath = relative(destinationRoot, destinationPath);
  if (!scopedPath || scopedPath === ".." || scopedPath.startsWith(`..${sep}`) || isAbsolute(scopedPath)) {
    throw new ArchiveFormatError("invalid_restore_path", "The Restore path must stay within the selected destination");
  }
  if (basename(destinationPath) !== entryName) {
    throw new ArchiveFormatError("invalid_restore_path", "The Restore path does not identify the selected archive item");
  }
  return destinationPath;
}

function directoriesByFilesystemDepth(
  directories: PreparedDirectoryItem[],
  deepestFirst: boolean,
): PreparedDirectoryItem[] {
  return directories
    .map((directory, index) => ({ directory, index, depth: filesystemPathDepth(directory.path) }))
    .sort((left, right) => {
      const depthOrder = deepestFirst ? right.depth - left.depth : left.depth - right.depth;
      if (depthOrder !== 0) return depthOrder;
      return deepestFirst ? right.index - left.index : left.index - right.index;
    })
    .map(({ directory }) => directory);
}

function filesystemPathDepth(path: string): number {
  return resolve(path).split(sep).filter(Boolean).length;
}

function canonicalRestorePath(path: string): string {
  return resolve(realpathSync(dirname(path)), basename(path));
}

function isTerminal(state: RestoreJobSummary["state"]): boolean {
  return state === "completed" || state === "failed" || state === "canceled";
}

function jobCanceled(job: RestoreJob): boolean {
  return job.summary.state === "canceled";
}

function workReservations(
  work: WorkItem,
): Array<Pick<PathReservation, "path" | "comparisonPath" | "subtree" | "global">> {
  if (work.kind === "expand") return [];
  if (work.kind === "prepare") {
    return [{ path: "", comparisonPath: "", subtree: true, global: true }];
  }
  const partialPath = partialFilePath(work.data.path, work.data.item.identity);
  if (partialPath === work.data.path) return [pathReservation(work.data.path)];
  return [
    pathReservation(work.data.path),
    pathReservation(partialPath),
  ];
}

function reservationsConflict(
  left: Pick<PathReservation, "comparisonPath" | "subtree" | "global">,
  right: Pick<PathReservation, "comparisonPath" | "subtree" | "global">,
): boolean {
  if (left.global || right.global) return true;
  if (left.comparisonPath === right.comparisonPath) return true;
  return (left.subtree && containsPath(left.comparisonPath, right.comparisonPath))
    || (right.subtree && containsPath(right.comparisonPath, left.comparisonPath));
}

function pathReservation(
  path: string,
  subtree = false,
): Pick<PathReservation, "path" | "comparisonPath" | "subtree" | "global"> {
  return {
    path,
    comparisonPath: path.normalize("NFD").toLowerCase(),
    subtree,
    global: false,
  };
}

function containsPath(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === ""
    || (childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative));
}

function samePartialClaim(left: PartialClaim, right: PartialClaim): boolean {
  return left.identity === right.identity && left.destinationPath === right.destinationPath;
}

function claimsCanShareInode(left: PartialClaim, right: PartialClaim): boolean {
  return left.readOnlyExactSkip
    && right.readOnlyExactSkip
    && left.identity === right.identity;
}

function claimPathKey(path: string): string {
  return path.normalize("NFD").toLowerCase();
}

function areDistinctCaseSensitiveEntries(left: string, right: string): boolean {
  const leftName = basename(left);
  const rightName = basename(right);
  if (leftName === rightName) return false;
  const leftParent = realpathSync(dirname(left));
  const rightParent = realpathSync(dirname(right));
  if (leftParent !== rightParent) return false;
  const entries = new Set(readdirSync(leftParent));
  return entries.has(leftName) && entries.has(rightName);
}

function workErrorPath(work: WorkItem, fallback: string): string {
  if (work.kind === "expand") return work.path;
  if (work.kind === "data") return work.data.path;
  return work.directories[0]?.path ?? fallback;
}

async function fileIdentityIfExists(path: string): Promise<FileIdentity | null> {
  try {
    const value = await lstat(path, { bigint: true });
    return { inode: `${value.dev}:${value.ino}`, links: value.nlink };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
