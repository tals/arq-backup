import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchiveEntrySummary, CloudBucket } from "../../shared/contracts";
import type { BrowsableArchiveRepository } from "../archive/arq7/session-store";
import { ArchiveSessionStore } from "../archive/arq7/session-store";
import type { CloudStorageProvider } from "../cloud/provider";
import type { RestoreItemDescriptor } from "./source";
import { RestoreQueue } from "./queue";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("Restore Queue", () => {
  test("runs four workers by default and completes independent File Restore Jobs", async () => {
    const root = await temporaryDirectory();
    const sessions = new ArchiveSessionStore();
    const repository = new QueueRepository(6, 30);
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    for (let index = 0; index < 6; index += 1) queue.enqueue(sessionId, `file-${index}`, root);

    await waitUntil(() => queue.snapshot().jobs.every(job => job.state === "completed"));
    expect(repository.maximumActiveReads).toBe(4);
    expect(queue.snapshot()).toMatchObject({ concurrency: 4, activeWorkers: 0 });
    expect(await readFile(join(root, "file-0.txt"), "utf8")).toBe("x");
    queue.destroy();
    sessions.destroy();
  });

  test("keeps another Job running when one File fails and reports the exact failure path", async () => {
    const root = await temporaryDirectory();
    const sessions = new ArchiveSessionStore();
    const repository = new QueueRepository(2, 0, "file-0");
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "file-0", root);
    queue.enqueue(sessionId, "file-1", root);

    await waitUntil(() => queue.snapshot().jobs.every(job => job.state === "completed" || job.state === "failed"));
    const failed = queue.snapshot().jobs.find(job => job.state === "failed");
    expect(failed?.error?.path).toBe(join(root, "file-0.txt"));
    expect(failed?.error?.message).toContain("injected read failure");
    expect(await readFile(join(root, "file-1.txt"), "utf8")).toBe("x");
    queue.destroy();
    sessions.destroy();
  });

  test("serializes duplicate jobs that target the same destination and Partial File", async () => {
    const root = await temporaryDirectory();
    const sessions = new ArchiveSessionStore();
    const repository = new QueueRepository(1, 30);
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "file-0", root);
    queue.enqueue(sessionId, "file-0", root);

    await waitUntil(() => queue.snapshot().jobs.every(job => job.state === "completed"));
    expect(repository.maximumActiveReads).toBe(1);
    expect(queue.snapshot().jobs.filter(job => job.skippedFiles === 1)).toHaveLength(1);
    expect(await readFile(join(root, "file-0.txt"), "utf8")).toBe("x");
    queue.destroy();
    sessions.destroy();
  });

  test("expands a Folder into pooled work and keeps its leased session alive after browsing locks", async () => {
    const root = await temporaryDirectory();
    const sessions = new ArchiveSessionStore();
    const repository = new FolderRepository();
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    const job = queue.enqueue(sessionId, "root", root);
    sessions.remove(sessionId);
    expect(repository.destroyed).toBe(false);

    await waitUntil(() => queue.snapshot().jobs[0]?.state === "completed");
    const completed = queue.snapshot().jobs.find(candidate => candidate.id === job.id);
    expect(completed).toMatchObject({ totalFiles: 2, completedFiles: 2, totalBytes: 2, completedBytes: 2 });
    expect(await readFile(join(root, "restored", "a.txt"), "utf8")).toBe("a");
    expect(await readFile(join(root, "restored", "nested", "b.txt"), "utf8")).toBe("b");
    expect(repository.destroyed).toBe(true);
    queue.destroy();
    sessions.destroy();
  });

  test("cancels active work without deleting its plaintext Partial File", async () => {
    const root = await temporaryDirectory();
    const sessions = new ArchiveSessionStore();
    const repository = new QueueRepository(1, 80);
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    const job = queue.enqueue(sessionId, "file-0", root);
    await waitUntil(() => queue.snapshot().jobs[0]?.state === "running");
    queue.cancel(job.id);
    expect(queue.snapshot().jobs[0]?.state).toBe("canceled");
    await waitUntil(() => queue.snapshot().activeWorkers === 0);
    const files = (await readdir(root)).filter(name => name.endsWith(".partial"));
    expect(files).toHaveLength(1);
    expect((await readFile(join(root, files[0]!))).byteLength).toBe(0);
    queue.destroy();
    sessions.destroy();
  });
});

class QueueRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";
  activeReads = 0;
  maximumActiveReads = 0;

  constructor(readonly count: number, readonly delay: number, readonly failingToken: string | null = null) {}

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return `identity-${token}`;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    const index = Number(token.slice("file-".length));
    if (!Number.isInteger(index) || index < 0 || index >= this.count) throw new Error(`unknown token ${token}`);
    return {
      entry: {
        token,
        name: `${token}.txt`,
        kind: "file",
        size: 1,
        modifiedAt: new Date(0).toISOString(),
        mode: 0o100600,
        containedFiles: 0,
      },
      identity: this.restoreIdentity(token),
      modifiedSeconds: 0,
      modifiedNanoseconds: 0,
    };
  }

  async listChildren(_token: string): Promise<ArchiveEntrySummary[]> {
    return [];
  }

  async *readData(token: string): AsyncIterable<Uint8Array> {
    this.activeReads += 1;
    this.maximumActiveReads = Math.max(this.maximumActiveReads, this.activeReads);
    try {
      if (this.delay) await new Promise(resolve => setTimeout(resolve, this.delay));
      if (token === this.failingToken) throw new Error("injected read failure");
      yield Buffer.from("x");
    } finally {
      this.activeReads -= 1;
    }
  }

  destroy(): void {}
}

class FolderRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";
  destroyed = false;

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return `folder-identity-${token}`;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    const kind = token === "root" || token === "nested" ? "folder" as const : "file" as const;
    const name = token === "root" ? "restored" : token === "nested" ? "nested" : `${token.slice(-1)}.txt`;
    return {
      entry: {
        token,
        name,
        kind,
        size: kind === "file" ? 1 : 0,
        modifiedAt: new Date(0).toISOString(),
        mode: kind === "file" ? 0o100600 : 0o040700,
        containedFiles: kind === "folder" ? 1 : 0,
      },
      identity: this.restoreIdentity(token),
      modifiedSeconds: 0,
      modifiedNanoseconds: 0,
    };
  }

  async listChildren(token: string): Promise<ArchiveEntrySummary[]> {
    if (token === "root") return [this.getEntry("file-a"), this.getEntry("nested")];
    if (token === "nested") return [this.getEntry("file-b")];
    throw new Error(`not a folder: ${token}`);
  }

  async *readData(token: string): AsyncIterable<Uint8Array> {
    yield Buffer.from(token.endsWith("a") ? "a" : "b");
  }

  destroy(): void {
    this.destroyed = true;
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Restore Queue");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "arq-restore-queue-"));
  temporaryDirectories.push(path);
  return path;
}
