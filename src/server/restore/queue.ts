import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type {
  ArchiveEntrySummary,
  RestoreJobSummary,
  RestoreQueueSnapshot,
} from "../../shared/contracts";
import type { ArchiveSessionLease, ArchiveSessionStore } from "../archive/arq7/session-store";
import { ArchiveFormatError } from "../archive/common/errors";
import {
  ensureRestoreDirectory,
  finalizeRestoreDirectory,
  materializeRegularFile,
  materializeSymlink,
  RestoreCanceledError,
} from "./materializer";
import type { RestoreItemDescriptor } from "./source";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 4;
const MAX_RESTORE_DEPTH = 1_024;

type DirectoryItem = { path: string; item: RestoreItemDescriptor };
type DataItem = { token: string; path: string; item: RestoreItemDescriptor };
type WorkItem =
  | { kind: "expand"; jobId: string; token: string; path: string }
  | { kind: "data"; jobId: string; data: DataItem };

type RestoreJob = {
  summary: RestoreJobSummary;
  lease: ArchiveSessionLease;
  remainingWork: number;
  directories: DirectoryItem[];
  finalizing: boolean;
  released: boolean;
};

export class RestoreQueue {
  readonly #jobs = new Map<string, RestoreJob>();
  readonly #pending: WorkItem[] = [];
  readonly #busyDestinations = new Set<string>();
  #concurrency = DEFAULT_CONCURRENCY;
  #activeWorkers = 0;
  #destroyed = false;

  constructor(readonly sessions: ArchiveSessionStore) {}

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
      throw new ArchiveFormatError("invalid_concurrency", "Restore concurrency must be an integer from 1 through 4");
    }
    this.#concurrency = value;
    this.#pump();
    return this.snapshot();
  }

  enqueue(sessionId: string, token: string, destinationDirectory: string): RestoreJobSummary {
    if (this.#destroyed) throw new ArchiveFormatError("restore_queue_stopped", "The Restore Queue has stopped");
    if (!isAbsolute(destinationDirectory)) {
      throw new ArchiveFormatError("invalid_destination", "Choose an absolute local destination directory");
    }
    const lease = this.sessions.acquire(sessionId);
    if (!lease) throw new ArchiveFormatError("missing_session", "This archive is locked or the server restarted");
    try {
      const item = lease.repository.describeRestoreItem(token);
      const destinationPath = resolve(destinationDirectory, item.entry.name);
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

  destroy(): void {
    this.#destroyed = true;
    this.#pending.length = 0;
    for (const job of this.#jobs.values()) {
      if (!isTerminal(job.summary.state)) job.summary.state = "canceled";
      this.#release(job);
    }
  }

  #pump(): void {
    while (!this.#destroyed && this.#activeWorkers < this.#concurrency && this.#pending.length > 0) {
      const pendingIndex = this.#pending.findIndex(work =>
        work.kind === "expand" || !this.#busyDestinations.has(work.data.path));
      if (pendingIndex < 0) return;
      const [work] = this.#pending.splice(pendingIndex, 1) as [WorkItem];
      if (work.kind === "data") this.#busyDestinations.add(work.data.path);
      this.#activeWorkers += 1;
      void this.#run(work).finally(() => {
        if (work.kind === "data") this.#busyDestinations.delete(work.data.path);
        this.#activeWorkers -= 1;
        this.#pump();
      });
    }
  }

  async #run(work: WorkItem): Promise<void> {
    const job = this.#jobs.get(work.jobId);
    if (!job) return;
    try {
      if (isTerminal(job.summary.state)) return;
      if (work.kind === "expand") await this.#expand(job, work.token, work.path);
      else await this.#materialize(job, work.data);
    } catch (error) {
      if (error instanceof RestoreCanceledError && job.summary.state === "canceled") return;
      this.#fail(job, work.kind === "expand" ? work.path : work.data.path, error);
    } finally {
      job.remainingWork -= 1;
      await this.#finishIfDone(job);
    }
  }

  async #expand(job: RestoreJob, token: string, path: string): Promise<void> {
    job.summary.state = "expanding";
    job.summary.currentPath = path;
    const dataItems: DataItem[] = [];
    await this.#collectFolder(job, token, path, 0, dataItems);
    if (jobCanceled(job)) throw new RestoreCanceledError();
    job.remainingWork += dataItems.length;
    for (const data of dataItems) this.#pending.push({ kind: "data", jobId: job.summary.id, data });
    job.summary.state = dataItems.length > 0 ? "running" : "queued";
    job.summary.currentPath = null;
    this.#pump();
  }

  async #collectFolder(
    job: RestoreJob,
    token: string,
    path: string,
    depth: number,
    dataItems: DataItem[],
  ): Promise<void> {
    if (jobCanceled(job)) throw new RestoreCanceledError();
    if (depth > MAX_RESTORE_DEPTH) throw new Error(`Restore folder depth exceeds ${MAX_RESTORE_DEPTH}: ${path}`);
    job.summary.currentPath = path;
    const children = await job.lease.repository.listChildren(token);
    const directory = job.lease.repository.describeRestoreItem(token);
    await ensureRestoreDirectory(path);
    job.directories.push({ path, item: directory });
    for (const child of children) {
      if (jobCanceled(job)) throw new RestoreCanceledError();
      const item = job.lease.repository.describeRestoreItem(child.token);
      const childPath = resolve(path, item.entry.name);
      if (item.entry.kind === "folder") {
        await this.#collectFolder(job, child.token, childPath, depth + 1, dataItems);
      } else {
        dataItems.push({ token: child.token, path: childPath, item });
        job.summary.totalFiles += 1;
        job.summary.totalBytes += item.entry.size;
        if (!Number.isSafeInteger(job.summary.totalBytes)) throw new Error(`Restore byte count is too large: ${path}`);
      }
    }
  }

  async #materialize(job: RestoreJob, data: DataItem): Promise<void> {
    job.summary.state = "running";
    job.summary.currentPath = data.path;
    const callbacks = {
      canceled: () => isTerminal(job.summary.state) || this.#destroyed,
      onBytes: (bytes: number) => {
        job.summary.completedBytes += bytes;
      },
    };
    const result = data.item.entry.kind === "symlink"
      ? await materializeSymlink(job.lease.repository, data.token, data.path, data.item, callbacks)
      : await materializeRegularFile(job.lease.repository, data.token, data.path, data.item, callbacks);
    job.summary.completedFiles += 1;
    if (result.skipped) job.summary.skippedFiles += 1;
  }

  async #finishIfDone(job: RestoreJob): Promise<void> {
    if (job.remainingWork !== 0 || job.finalizing) return;
    job.finalizing = true;
    try {
      if (!isTerminal(job.summary.state)) {
        try {
          for (const directory of [...job.directories].reverse()) {
            job.summary.currentPath = directory.path;
            await finalizeRestoreDirectory(directory.path, directory.item);
          }
          job.summary.state = "completed";
        } catch (error) {
          this.#fail(job, job.summary.currentPath ?? job.summary.destinationPath, error);
        }
      }
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

  #release(job: RestoreJob): void {
    if (job.released) return;
    job.released = true;
    job.lease.release();
  }
}

function isTerminal(state: RestoreJobSummary["state"]): boolean {
  return state === "completed" || state === "failed" || state === "canceled";
}

function jobCanceled(job: RestoreJob): boolean {
  return job.summary.state === "canceled";
}
