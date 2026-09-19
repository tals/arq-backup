import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, lstat, lutimes, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ArchiveEntrySummary, CloudBucket } from "../../shared/contracts";
import type { BrowsableArchiveRepository } from "../archive/arq7/session-store";
import { ArchiveSessionStore } from "../archive/arq7/session-store";
import type { CloudStorageProvider } from "../cloud/provider";
import type { RestoreItemDescriptor } from "./source";
import { partialFilePath } from "./materializer";
import { RestoreQueue } from "./queue";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("Restore Queue", () => {
  test("allows up to 32 workers while keeping the default at four", () => {
    const sessions = new ArchiveSessionStore();
    const queue = new RestoreQueue(sessions);

    expect(queue.snapshot().concurrency).toBe(4);
    expect(queue.setConcurrency(32).concurrency).toBe(32);
    expect(() => queue.setConcurrency(33)).toThrow("Restore concurrency must be an integer from 1 through 32");
    queue.destroy();
    sessions.destroy();
  });

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

  test("recreates an item's archive hierarchy beneath the selected Restore root", async () => {
    const root = await temporaryDirectory();
    const sessions = new ArchiveSessionStore();
    const repository = new QueueRepository(1, 0);
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);

    const job = queue.enqueue(sessionId, "file-0", root, "Home/Documents/Reports/file-0.txt");

    await waitUntil(() => queue.snapshot().jobs.some(candidate => candidate.id === job.id && candidate.state === "completed"));
    expect(job.destinationPath).toBe(join(root, "Home", "Documents", "Reports", "file-0.txt"));
    expect(await readFile(job.destinationPath, "utf8")).toBe("x");
    expect((await lstat(join(root, "Home", "Documents", "Reports"))).isDirectory()).toBe(true);
    await queue.destroy();
    sessions.destroy();
  });

  test("rejects Restore paths outside the selected Restore root", async () => {
    const root = await temporaryDirectory();
    const sessions = new ArchiveSessionStore();
    const repository = new QueueRepository(1, 0);
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);

    expect(() => queue.enqueue(sessionId, "file-0", root, "../file-0.txt"))
      .toThrow("Restore path must stay within the selected destination");
    expect(() => queue.enqueue(sessionId, "file-0", root, join(root, "file-0.txt")))
      .toThrow("Restore path must be relative to the selected destination");
    expect(queue.snapshot().jobs).toHaveLength(0);
    await queue.destroy();
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

  test("fails loudly when symlinked parent paths alias the same absent destination", async () => {
    const root = await temporaryDirectory();
    const realParent = join(root, "real", "sub");
    const aliasParent = join(root, "alias", "sub");
    await mkdir(realParent, { recursive: true });
    await symlink("real", join(root, "alias"));
    const sessions = new ArchiveSessionStore();
    const repository = new SymlinkedParentRepository();
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "one", realParent);
    queue.enqueue(sessionId, "two", aliasParent);

    await waitUntil(() => queue.snapshot().jobs.every(job => job.state === "completed" || job.state === "failed"));
    expect(queue.snapshot().jobs.filter(job => job.state === "completed")).toHaveLength(1);
    const failed = queue.snapshot().jobs.find(job => job.state === "failed");
    expect(failed?.error?.message).toContain("filesystem alias");
    expect(await readFile(join(realParent, "shared.txt"), "utf8")).toBe("one");
    await queue.destroy();
    sessions.destroy();
  });

  test("serializes duplicate Folder jobs for their full destination subtree", async () => {
    const root = await temporaryDirectory();
    const sessions = new ArchiveSessionStore();
    const repository = new FolderRepository(30);
    const sessionId = sessions.add(repository, []);
    let activeFinalizations = 0;
    let maximumActiveFinalizations = 0;
    const queue = new RestoreQueue(sessions, {
      finalizeDirectory: async () => {
        activeFinalizations += 1;
        maximumActiveFinalizations = Math.max(maximumActiveFinalizations, activeFinalizations);
        try {
          await new Promise(resolve => setTimeout(resolve, 5));
        } finally {
          activeFinalizations -= 1;
        }
      },
    });
    queue.enqueue(sessionId, "root", root);
    queue.enqueue(sessionId, "root", root);

    await waitUntil(() => queue.snapshot().jobs.every(job => job.state === "completed"));
    expect(repository.maximumActiveListings).toBe(2);
    expect(maximumActiveFinalizations).toBe(1);
    expect(await readFile(join(root, "restored", "nested", "b.txt"), "utf8")).toBe("b");
    queue.destroy();
    sessions.destroy();
  });

  test("hard-errors instead of overwriting another item's retained Partial File", async () => {
    const root = await temporaryDirectory();
    const originalPath = join(root, "original.txt");
    const retainedPath = partialFilePath(originalPath, "original-identity");
    const collisionName = basename(retainedPath).toUpperCase();
    const sessions = new ArchiveSessionStore();
    const repository = new PartialCollisionRepository(collisionName);
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "original", root);
    await waitUntil(() => queue.snapshot().jobs.some(job => job.name === "original.txt" && job.state === "failed"));
    expect(await readFile(retainedPath, "utf8")).toBe("a");

    queue.enqueue(sessionId, "collision", root);
    await waitUntil(() => queue.snapshot().jobs.some(job => job.name === collisionName && job.state === "failed"));
    const collision = queue.snapshot().jobs.find(job => job.name === collisionName);
    expect(collision?.error?.message).toContain("retained Partial File");
    expect(await readFile(retainedPath, "utf8")).toBe("a");
    queue.destroy();
    sessions.destroy();
  });

  test("rejects a retained Partial File that is hard-linked to its destination", async () => {
    const root = await temporaryDirectory();
    const destination = join(root, "hardlink.txt");
    const itemIdentity = "hardlink-identity";
    const partial = partialFilePath(destination, itemIdentity);
    await writeFile(destination, "a");
    await link(destination, partial);
    const sessions = new ArchiveSessionStore();
    const repository = new HardLinkRepository(itemIdentity);
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "file", root);

    await waitUntil(() => queue.snapshot().jobs[0]?.state === "failed");
    expect(queue.snapshot().jobs[0]?.error?.message).toContain("hard link");
    expect(await readFile(destination, "utf8")).toBe("a");
    expect(await readFile(partial, "utf8")).toBe("a");
    queue.destroy();
    sessions.destroy();
  });

  test("ignores an unused retained Partial File when the destination is an exact skip", async () => {
    const root = await temporaryDirectory();
    const destination = join(root, "hardlink.txt");
    const itemIdentity = "hardlink-identity";
    const partial = partialFilePath(destination, itemIdentity);
    await writeFile(destination, "ab");
    await utimes(destination, 0, 0);
    await link(destination, partial);
    const sessions = new ArchiveSessionStore();
    const repository = new HardLinkRepository(itemIdentity);
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "file", root);

    await waitUntil(() => queue.snapshot().jobs[0]?.state === "completed");
    expect(queue.snapshot().jobs[0]?.skippedFiles).toBe(1);
    expect(await readFile(destination, "utf8")).toBe("ab");
    expect(await readFile(partial, "utf8")).toBe("ab");
    await queue.destroy();
    sessions.destroy();
  });

  test("skips two exact destinations that are hard links of the same archived item", async () => {
    const root = await temporaryDirectory();
    const left = join(root, "left.txt");
    const right = join(root, "right.txt");
    await writeFile(left, "x");
    await utimes(left, 0, 0);
    await link(left, right);
    const sessions = new ArchiveSessionStore();
    const repository = new ExactHardLinkRepository(true);
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "left", root);
    queue.enqueue(sessionId, "right", root);

    await waitUntil(() => queue.snapshot().jobs.every(job => job.state === "completed"));
    expect(queue.snapshot().jobs.every(job => job.skippedFiles === 1)).toBeTrue();
    expect(repository.dataReads).toBe(0);
    expect((await lstat(left, { bigint: true })).ino).toBe((await lstat(right, { bigint: true })).ino);
    await queue.destroy();
    sessions.destroy();
  });

  test("fails loudly when exact hard-linked destinations describe different archived items", async () => {
    const root = await temporaryDirectory();
    const left = join(root, "left.txt");
    const right = join(root, "right.txt");
    await writeFile(left, "x");
    await utimes(left, 0, 0);
    await link(left, right);
    const sessions = new ArchiveSessionStore();
    const repository = new ExactHardLinkRepository(false);
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "left", root);
    queue.enqueue(sessionId, "right", root);

    await waitUntil(() => queue.snapshot().jobs.every(job => job.state === "completed" || job.state === "failed"));
    expect(queue.snapshot().jobs.filter(job => job.state === "completed")).toHaveLength(1);
    const failed = queue.snapshot().jobs.find(job => job.state === "failed");
    expect(failed?.error?.message).toMatch(/filesystem alias|hard-linked/);
    expect(repository.dataReads).toBe(0);
    expect(await readFile(left, "utf8")).toBe("x");
    expect(await readFile(right, "utf8")).toBe("x");
    await queue.destroy();
    sessions.destroy();
  });

  test("atomically detaches and overwrites one hard-link name after its alias was skipped", async () => {
    const root = await temporaryDirectory();
    const left = join(root, "left.txt");
    const right = join(root, "right.txt");
    await writeFile(left, "x");
    await utimes(left, 0, 0);
    await link(left, right);
    const sessions = new ArchiveSessionStore();
    const repository = new HardLinkOverwriteRepository();
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.setConcurrency(1);
    queue.enqueue(sessionId, "left", root);
    queue.enqueue(sessionId, "right", root);

    await waitUntil(() => queue.snapshot().jobs.every(job => job.state === "completed"));
    expect(queue.snapshot().jobs.filter(job => job.skippedFiles === 1)).toHaveLength(1);
    expect(repository.dataReads).toBe(1);
    expect(await readFile(left, "utf8")).toBe("x");
    expect(await readFile(right, "utf8")).toBe("yz");
    expect((await lstat(left, { bigint: true })).ino).not.toBe((await lstat(right, { bigint: true })).ino);
    await queue.destroy();
    sessions.destroy();
  });

  test("retains every completed path for an inode after one hard-link alias is overwritten", async () => {
    const root = await temporaryDirectory();
    const left = join(root, "left.txt");
    const middle = join(root, "middle.txt");
    const right = join(root, "right.txt");
    await writeFile(left, "x");
    await utimes(left, 0, 0);
    await link(left, middle);
    await link(left, right);
    const sessions = new ArchiveSessionStore();
    const repository = new FinalInodeHistoryRepository();
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.setConcurrency(1);

    queue.enqueue(sessionId, "left", root);
    queue.enqueue(sessionId, "middle-same", root);
    await waitUntil(() => queue.snapshot().jobs.every(job => job.state === "completed"));
    queue.enqueue(sessionId, "middle-new", root);
    await waitUntil(() => queue.snapshot().jobs.find(job => job.name === "middle.txt" && job.skippedFiles === 0)?.state === "completed");
    queue.enqueue(sessionId, "right-different", root);
    await waitUntil(() => queue.snapshot().jobs.some(job => job.name === "right.txt" && job.state === "failed"));

    const rightJob = queue.snapshot().jobs.find(job => job.name === "right.txt");
    expect(rightJob?.error?.message).toContain("filesystem alias");
    expect(await readFile(left, "utf8")).toBe("x");
    expect(await readFile(middle, "utf8")).toBe("yz");
    expect(await readFile(right, "utf8")).toBe("x");
    await queue.destroy();
    sessions.destroy();
  });

  test("retains inode history across case-fold-colliding names on a case-sensitive filesystem", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "CaseProbe"), "probe");
    const caseInsensitive = await lstat(join(root, "caseprobe")).then(() => true, () => false);
    if (caseInsensitive) return;
    const report = join(root, "Report");
    const alias = join(root, "Alias");
    await writeFile(report, "x");
    await utimes(report, 0, 0);
    await link(report, alias);
    const sessions = new ArchiveSessionStore();
    const repository = new CaseFoldInodeHistoryRepository();
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.setConcurrency(1);

    queue.enqueue(sessionId, "upper", root);
    await waitUntil(() => queue.snapshot().jobs[0]?.state === "completed");
    queue.enqueue(sessionId, "lower", root);
    await waitUntil(() => queue.snapshot().jobs.some(job => job.name === "report" && job.state === "completed"));
    queue.enqueue(sessionId, "alias", root);
    await waitUntil(() => queue.snapshot().jobs.some(job => job.name === "Alias" && job.state === "failed"));

    const aliasJob = queue.snapshot().jobs.find(job => job.name === "Alias");
    expect(aliasJob?.error?.message).toContain("filesystem alias");
    expect(await readFile(report, "utf8")).toBe("x");
    expect(await readFile(join(root, "report"), "utf8")).toBe("yz");
    expect(await readFile(alias, "utf8")).toBe("x");
    await queue.destroy();
    sessions.destroy();
  });

  test("allows same-identity exact hard links whose names differ only by case when both entries exist", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "CaseProbe"), "probe");
    const caseInsensitive = await lstat(join(root, "caseprobe")).then(() => true, () => false);
    if (caseInsensitive) return;
    const upper = join(root, "Report");
    const lower = join(root, "report");
    await writeFile(upper, "x");
    await utimes(upper, 0, 0);
    await link(upper, lower);
    const sessions = new ArchiveSessionStore();
    const repository = new CaseFoldExactAliasRepository();
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.setConcurrency(1);
    queue.enqueue(sessionId, "upper", root);
    queue.enqueue(sessionId, "lower", root);

    await waitUntil(() => queue.snapshot().jobs.every(job => job.state === "completed"));
    expect(queue.snapshot().jobs.every(job => job.skippedFiles === 1)).toBeTrue();
    expect((await lstat(upper, { bigint: true })).ino).toBe((await lstat(lower, { bigint: true })).ino);
    await queue.destroy();
    sessions.destroy();
  });

  test("fails loudly when archived symlinks resolve to hard-linked destination aliases", async () => {
    const root = await temporaryDirectory();
    const left = join(root, "left-link");
    const right = join(root, "right-link");
    const target = Buffer.from("../target");
    await symlink(target, left);
    await lutimes(left, 0, 0);
    const linked = Bun.spawnSync({ cmd: ["/bin/ln", "-P", left, right], stdout: "pipe", stderr: "pipe" });
    expect(linked.success).toBeTrue();
    expect((await lstat(left, { bigint: true })).ino).toBe((await lstat(right, { bigint: true })).ino);
    const sessions = new ArchiveSessionStore();
    const repository = new SymlinkHardLinkAliasRepository(target);
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.setConcurrency(1);
    queue.enqueue(sessionId, "left", root);
    queue.enqueue(sessionId, "right", root);

    await waitUntil(() => queue.snapshot().jobs.every(job => job.state === "completed" || job.state === "failed"));
    expect(queue.snapshot().jobs.filter(job => job.state === "completed")).toHaveLength(1);
    const failed = queue.snapshot().jobs.find(job => job.state === "failed");
    expect(failed?.error?.message).toContain("filesystem alias");
    expect((await lstat(left)).mode & 0o777).toBe(0o600);
    expect((await lstat(right)).mode & 0o777).toBe(0o600);
    await queue.destroy();
    sessions.destroy();
  });

  test("hard-errors instead of consuming another completed output as a Partial File", async () => {
    const root = await temporaryDirectory();
    const targetPath = join(root, "target.txt");
    const collidingOutput = partialFilePath(targetPath, "target-identity");
    const sessions = new ArchiveSessionStore();
    const repository = new CompletedPartialCollisionRepository(basename(collidingOutput));
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "completed", root);
    await waitUntil(() => queue.snapshot().jobs.some(job => job.name === basename(collidingOutput) && job.state === "completed"));

    queue.enqueue(sessionId, "target", root);
    await waitUntil(() => queue.snapshot().jobs.some(job => job.name === "target.txt" && job.state === "failed"));
    const target = queue.snapshot().jobs.find(job => job.name === "target.txt");
    expect(target?.error?.message).toContain("completed restore item");
    expect(await readFile(collidingOutput, "utf8")).toBe("a");
    queue.destroy();
    sessions.destroy();
  });

  test("discovers escaping Folder paths before taking one deadlock-free local reservation", async () => {
    const root = await temporaryDirectory();
    const sessions = new ArchiveSessionStore();
    const repository = new EscapingFolderRepository();
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "root-a", root);
    queue.enqueue(sessionId, "root-b", root);

    await waitUntil(() => queue.snapshot().jobs.every(job => job.state === "completed"));
    expect(await readFile(join(root, "A", "from-b.txt"), "utf8")).toBe("b");
    expect(await readFile(join(root, "B", "from-a.txt"), "utf8")).toBe("a");
    queue.destroy();
    sessions.destroy();
  });

  test("finalizes trusted escaping Folder names in filesystem descendant-first order", async () => {
    const root = await temporaryDirectory();
    const restored = join(root, "restored");
    const sessions = new ArchiveSessionStore();
    const repository = new InvertedFolderRepository();
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "root", root);

    await waitUntil(() => queue.snapshot().jobs[0]?.state === "completed" || queue.snapshot().jobs[0]?.state === "failed");
    const state = queue.snapshot().jobs[0]?.state;
    const rootMode = (await lstat(root)).mode & 0o777;
    await chmod(root, 0o700);
    const restoredMode = (await lstat(restored)).mode & 0o777;
    await chmod(restored, 0o700);
    expect(state).toBe("completed");
    expect(rootMode).toBe(0o000);
    expect(restoredMode).toBe(0o500);
    await queue.destroy();
    sessions.destroy();
  });

  test("fails loudly only when distinct archived directories alias one destination inode", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "CaseProbe"), "probe");
    const caseInsensitive = await lstat(join(root, "caseprobe")).then(() => true, () => false);
    const sessions = new ArchiveSessionStore();
    const repository = new AliasedDirectoryRepository();
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "root", root);

    await waitUntil(() => queue.snapshot().jobs[0]?.state === "completed" || queue.snapshot().jobs[0]?.state === "failed");
    const job = queue.snapshot().jobs[0]!;
    if (caseInsensitive) {
      expect(job.state).toBe("failed");
      expect(job.error?.message).toContain("same destination inode");
    } else {
      expect(job.state).toBe("completed");
      expect((await lstat(join(root, "directory-aliases", "Dir"))).isDirectory()).toBeTrue();
      expect((await lstat(join(root, "directory-aliases", "dir"))).isDirectory()).toBeTrue();
    }
    await queue.destroy();
    sessions.destroy();
  });

  test("fails loudly on case-folded aliases only when the destination filesystem aliases them", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "CaseProbe"), "probe");
    const caseInsensitive = await lstat(join(root, "caseprobe")).then(() => true, () => false);
    const sessions = new ArchiveSessionStore();
    const repository = new AliasedFolderRepository();
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "root", root);

    await waitUntil(() => queue.snapshot().jobs.every(job => job.state === "completed" || job.state === "failed"));
    const job = queue.snapshot().jobs[0]!;
    if (caseInsensitive) {
      expect(job.state).toBe("failed");
      expect(job.error?.message).toContain("filesystem alias");
    } else {
      expect(job.state).toBe("completed");
      expect(await readFile(join(root, "aliases", "Report"), "utf8")).toBe("A");
      expect(await readFile(join(root, "aliases", "report"), "utf8")).toBe("BB");
    }
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

  test("reports the exact nested path when Folder preparation fails", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "restored"));
    await writeFile(join(root, "restored", "nested"), "conflict");
    await chmod(join(root, "restored"), 0o555);
    const sessions = new ArchiveSessionStore();
    const repository = new FolderRepository();
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "root", root);

    await waitUntil(() => queue.snapshot().jobs[0]?.state === "failed");
    expect(queue.snapshot().jobs[0]?.error?.path).toBe(join(root, "restored", "nested"));
    expect((await lstat(join(root, "restored"))).mode & 0o777).toBe(0o555);
    await chmod(join(root, "restored"), 0o700);
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

  test("does not change a canceled Folder job back to completed during directory finalization", async () => {
    const root = await temporaryDirectory();
    const sessions = new ArchiveSessionStore();
    const repository = new DeepFolderRepository(1);
    const sessionId = sessions.add(repository, []);
    let reportFinalizing!: () => void;
    let continueFinalizing!: () => void;
    const finalizing = new Promise<void>(resolve => reportFinalizing = resolve);
    const finalizationBarrier = new Promise<void>(resolve => continueFinalizing = resolve);
    const queue = new RestoreQueue(sessions, {
      finalizeDirectory: async () => {
        reportFinalizing();
        await finalizationBarrier;
      },
    });
    const job = queue.enqueue(sessionId, "folder-0", root);
    await finalizing;
    queue.cancel(job.id);
    continueFinalizing();
    await waitUntil(() => queue.snapshot().activeWorkers === 0);
    expect(queue.snapshot().jobs.find(candidate => candidate.id === job.id)?.state).toBe("canceled");
    queue.destroy();
    sessions.destroy();
  });

  test("does not mutate the destination after cancellation during remote Folder discovery", async () => {
    const root = await temporaryDirectory();
    const sessions = new ArchiveSessionStore();
    let reportListing!: () => void;
    let continueListing!: () => void;
    const listing = new Promise<void>(resolve => reportListing = resolve);
    const listingBarrier = new Promise<void>(resolve => continueListing = resolve);
    const repository = new ControlledListingRepository(reportListing, listingBarrier);
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    const job = queue.enqueue(sessionId, "root", root);
    await listing;
    queue.cancel(job.id);
    continueListing();

    await waitUntil(() => queue.snapshot().activeWorkers === 0);
    await expect(lstat(join(root, "restored"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(queue.snapshot().jobs.find(candidate => candidate.id === job.id)?.state).toBe("canceled");
    queue.destroy();
    sessions.destroy();
  });

  test("waits for active work and rolls back prior directory modes during queue shutdown", async () => {
    const root = await temporaryDirectory();
    const restored = join(root, "restored");
    await mkdir(restored);
    chmodWithSpecialBits(restored, 0o1555);
    expect((await lstat(restored)).mode & 0o7777).toBe(0o1555);
    const sessions = new ArchiveSessionStore();
    const repository = new FolderRepository(0, 80);
    const sessionId = sessions.add(repository, []);
    const queue = new RestoreQueue(sessions);
    queue.enqueue(sessionId, "root", root);
    await waitUntil(() => queue.snapshot().jobs[0]?.state === "running");
    expect((await lstat(restored)).mode & 0o700).toBe(0o700);

    await queue.destroy();

    expect((await lstat(restored)).mode & 0o7777).toBe(0o1555);
    await chmod(restored, 0o700);
    sessions.destroy();
  });

  test("makes finalized ancestors traversable before rolling back descendant directory modes", async () => {
    const root = await temporaryDirectory();
    const parent = join(root, "folder-0");
    const child = join(parent, "folder-1");
    await mkdir(child, { recursive: true });
    await chmod(parent, 0o555);
    await chmod(child, 0o511);
    const sessions = new ArchiveSessionStore();
    const repository = new DeepFolderRepository(2);
    const sessionId = sessions.add(repository, []);
    let reportParentFinalizing!: () => void;
    let continueParentFinalizing!: () => void;
    const parentFinalizing = new Promise<void>(resolve => reportParentFinalizing = resolve);
    const parentBarrier = new Promise<void>(resolve => continueParentFinalizing = resolve);
    const queue = new RestoreQueue(sessions, {
      finalizeDirectory: async path => {
        await chmod(path, 0o000);
        if (path === parent) {
          reportParentFinalizing();
          await parentBarrier;
        }
      },
    });
    const job = queue.enqueue(sessionId, "folder-0", root);
    await parentFinalizing;
    queue.cancel(job.id);
    continueParentFinalizing();
    await waitUntil(() => queue.snapshot().activeWorkers === 0);

    expect((await lstat(parent)).mode & 0o777).toBe(0o555);
    expect((await lstat(child)).mode & 0o777).toBe(0o511);
    expect(queue.snapshot().jobs.find(candidate => candidate.id === job.id)?.state).toBe("canceled");
    await queue.destroy();
    await chmod(child, 0o700);
    await chmod(parent, 0o700);
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

class SymlinkedParentRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return `symlink-parent-${token}`;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    if (token !== "one" && token !== "two") throw new Error(`unknown token ${token}`);
    return {
      entry: {
        token,
        name: "shared.txt",
        kind: "file",
        size: token.length,
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
    await new Promise(resolve => setTimeout(resolve, 40));
    yield Buffer.from(token);
  }

  destroy(): void {}
}

class FolderRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";
  destroyed = false;
  activeListings = 0;
  maximumActiveListings = 0;

  constructor(readonly listingDelay = 0, readonly dataDelay = 0) {}

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
    this.activeListings += 1;
    this.maximumActiveListings = Math.max(this.maximumActiveListings, this.activeListings);
    try {
      if (this.listingDelay) await new Promise(resolve => setTimeout(resolve, this.listingDelay));
      if (token === "root") return [this.getEntry("file-a"), this.getEntry("nested")];
      if (token === "nested") return [this.getEntry("file-b")];
      throw new Error(`not a folder: ${token}`);
    } finally {
      this.activeListings -= 1;
    }
  }

  async *readData(token: string): AsyncIterable<Uint8Array> {
    if (this.dataDelay) await new Promise(resolve => setTimeout(resolve, this.dataDelay));
    yield Buffer.from(token.endsWith("a") ? "a" : "b");
  }

  destroy(): void {
    this.destroyed = true;
  }
}

class PartialCollisionRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";

  constructor(readonly collisionName: string) {}

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return token === "original" ? "original-identity" : "collision-identity";
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    if (token !== "original" && token !== "collision") throw new Error(`unknown token ${token}`);
    const name = token === "original" ? "original.txt" : this.collisionName;
    return {
      entry: {
        token,
        name,
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
    yield Buffer.from(token === "original" ? "a" : "b");
    if (token === "original") throw new Error("injected trailing failure");
  }

  destroy(): void {}
}

class HardLinkRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";

  constructor(readonly identity: string) {}

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(_token: string): string {
    return this.identity;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    if (token !== "file") throw new Error(`unknown token ${token}`);
    return {
      entry: {
        token,
        name: "hardlink.txt",
        kind: "file",
        size: 2,
        modifiedAt: new Date(0).toISOString(),
        mode: 0o100600,
        containedFiles: 0,
      },
      identity: this.identity,
      modifiedSeconds: 0,
      modifiedNanoseconds: 0,
    };
  }

  async listChildren(_token: string): Promise<ArchiveEntrySummary[]> {
    return [];
  }

  async *readData(_token: string): AsyncIterable<Uint8Array> {
    yield Buffer.from("ab");
    throw new Error("injected read failure");
  }

  destroy(): void {}
}

class ExactHardLinkRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";
  dataReads = 0;

  constructor(readonly sharedIdentity: boolean) {}

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return this.sharedIdentity ? "shared-hard-link-identity" : `hard-link-${token}`;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    if (token !== "left" && token !== "right") throw new Error(`unknown token ${token}`);
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

  async *readData(_token: string): AsyncIterable<Uint8Array> {
    this.dataReads += 1;
    yield Buffer.from("x");
  }

  destroy(): void {}
}

class HardLinkOverwriteRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";
  dataReads = 0;

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return `overwrite-hard-link-${token}`;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    if (token !== "left" && token !== "right") throw new Error(`unknown token ${token}`);
    const size = token === "left" ? 1 : 2;
    return {
      entry: {
        token,
        name: `${token}.txt`,
        kind: "file",
        size,
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
    this.dataReads += 1;
    yield Buffer.from(token === "left" ? "x" : "yz");
  }

  destroy(): void {}
}

class FinalInodeHistoryRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    if (token === "left" || token === "middle-same") return "shared-original-identity";
    return `inode-history-${token}`;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    const names: Record<string, string> = {
      left: "left.txt",
      "middle-same": "middle.txt",
      "middle-new": "middle.txt",
      "right-different": "right.txt",
    };
    const name = names[token];
    if (!name) throw new Error(`unknown token ${token}`);
    const size = token === "middle-new" ? 2 : 1;
    return {
      entry: {
        token,
        name,
        kind: "file",
        size,
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
    yield Buffer.from(token === "middle-new" ? "yz" : "x");
  }

  destroy(): void {}
}

class SymlinkHardLinkAliasRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";

  constructor(readonly target: Uint8Array) {}

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return `symlink-hard-link-${token}`;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    if (token !== "left" && token !== "right") throw new Error(`unknown token ${token}`);
    return {
      entry: {
        token,
        name: `${token}-link`,
        kind: "symlink",
        size: this.target.byteLength,
        modifiedAt: new Date(0).toISOString(),
        mode: token === "left" ? 0o120600 : 0o120777,
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

  async *readData(_token: string): AsyncIterable<Uint8Array> {
    yield Uint8Array.from(this.target);
  }

  destroy(): void {}
}

class CaseFoldInodeHistoryRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return `case-fold-history-${token}`;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    const name = token === "upper" ? "Report" : token === "lower" ? "report" : token === "alias" ? "Alias" : null;
    if (!name) throw new Error(`unknown token ${token}`);
    const size = token === "lower" ? 2 : 1;
    return {
      entry: {
        token,
        name,
        kind: "file",
        size,
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
    yield Buffer.from(token === "lower" ? "yz" : "x");
  }

  destroy(): void {}
}

class CaseFoldExactAliasRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(_token: string): string {
    return "case-fold-exact-shared";
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    if (token !== "upper" && token !== "lower") throw new Error(`unknown token ${token}`);
    return {
      entry: {
        token,
        name: token === "upper" ? "Report" : "report",
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

  async *readData(_token: string): AsyncIterable<Uint8Array> {
    throw new Error("exact aliases must not read archive data");
  }

  destroy(): void {}
}

class CompletedPartialCollisionRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";

  constructor(readonly completedName: string) {}

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return token === "target" ? "target-identity" : "completed-identity";
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    if (token !== "completed" && token !== "target") throw new Error(`unknown token ${token}`);
    const target = token === "target";
    return {
      entry: {
        token,
        name: target ? "target.txt" : this.completedName,
        kind: "file",
        size: target ? 2 : 1,
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
    yield Buffer.from(token === "target" ? "ab" : "a");
  }

  destroy(): void {}
}

class EscapingFolderRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return `escaping-${token}`;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    const folder = token === "root-a" || token === "root-b";
    const name = token === "root-a"
      ? "A"
      : token === "root-b"
        ? "B"
        : token === "file-a"
          ? "../B/from-a.txt"
          : "../A/from-b.txt";
    return {
      entry: {
        token,
        name,
        kind: folder ? "folder" : "file",
        size: folder ? 0 : 1,
        modifiedAt: new Date(0).toISOString(),
        mode: folder ? 0o040700 : 0o100600,
        containedFiles: folder ? 1 : 0,
      },
      identity: this.restoreIdentity(token),
      modifiedSeconds: 0,
      modifiedNanoseconds: 0,
    };
  }

  async listChildren(token: string): Promise<ArchiveEntrySummary[]> {
    if (token === "root-a") return [this.getEntry("file-a")];
    if (token === "root-b") return [this.getEntry("file-b")];
    throw new Error(`not a folder: ${token}`);
  }

  async *readData(token: string): AsyncIterable<Uint8Array> {
    yield Buffer.from(token === "file-a" ? "a" : "b");
  }

  destroy(): void {}
}

class InvertedFolderRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return `inverted-${token}`;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    if (token !== "root" && token !== "parent") throw new Error(`unknown token ${token}`);
    const isRoot = token === "root";
    return {
      entry: {
        token,
        name: isRoot ? "restored" : "..",
        kind: "folder",
        size: 0,
        modifiedAt: new Date(0).toISOString(),
        mode: isRoot ? 0o040500 : 0o040000,
        containedFiles: 0,
      },
      identity: this.restoreIdentity(token),
      modifiedSeconds: 0,
      modifiedNanoseconds: 0,
    };
  }

  async listChildren(token: string): Promise<ArchiveEntrySummary[]> {
    if (token === "root") return [this.getEntry("parent")];
    if (token === "parent") return [];
    throw new Error(`not a folder: ${token}`);
  }

  async *readData(_token: string): AsyncIterable<Uint8Array> {
    throw new Error("folders have no data");
  }

  destroy(): void {}
}

class AliasedDirectoryRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return `directory-alias-${token}`;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    if (token !== "root" && token !== "upper" && token !== "lower") throw new Error(`unknown token ${token}`);
    const name = token === "root" ? "directory-aliases" : token === "upper" ? "Dir" : "dir";
    return {
      entry: {
        token,
        name,
        kind: "folder",
        size: 0,
        modifiedAt: new Date(0).toISOString(),
        mode: 0o040700,
        containedFiles: 0,
      },
      identity: this.restoreIdentity(token),
      modifiedSeconds: 0,
      modifiedNanoseconds: 0,
    };
  }

  async listChildren(token: string): Promise<ArchiveEntrySummary[]> {
    if (token === "root") return [this.getEntry("upper"), this.getEntry("lower")];
    if (token === "upper" || token === "lower") return [];
    throw new Error(`not a folder: ${token}`);
  }

  async *readData(_token: string): AsyncIterable<Uint8Array> {
    throw new Error("folders have no data");
  }

  destroy(): void {}
}

class AliasedFolderRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return `alias-${token}`;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    const folder = token === "root";
    const name = token === "root" ? "aliases" : token === "upper" ? "Report" : "report";
    return {
      entry: {
        token,
        name,
        kind: folder ? "folder" : "file",
        size: folder ? 0 : token === "lower" ? 2 : 1,
        modifiedAt: new Date(0).toISOString(),
        mode: folder ? 0o040700 : 0o100600,
        containedFiles: folder ? 2 : 0,
      },
      identity: this.restoreIdentity(token),
      modifiedSeconds: 0,
      modifiedNanoseconds: 0,
    };
  }

  async listChildren(token: string): Promise<ArchiveEntrySummary[]> {
    if (token === "root") return [this.getEntry("upper"), this.getEntry("lower")];
    throw new Error(`not a folder: ${token}`);
  }

  async *readData(token: string): AsyncIterable<Uint8Array> {
    yield Buffer.from(token === "upper" ? "A" : "BB");
  }

  destroy(): void {}
}

class ControlledListingRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";

  constructor(
    readonly reportListing: () => void,
    readonly listingBarrier: Promise<void>,
  ) {}

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return `controlled-${token}`;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    if (token !== "root") throw new Error(`unknown token ${token}`);
    return {
      entry: {
        token,
        name: "restored",
        kind: "folder",
        size: 0,
        modifiedAt: new Date(0).toISOString(),
        mode: 0o040500,
        containedFiles: 0,
      },
      identity: this.restoreIdentity(token),
      modifiedSeconds: 0,
      modifiedNanoseconds: 0,
    };
  }

  async listChildren(_token: string): Promise<ArchiveEntrySummary[]> {
    this.reportListing();
    await this.listingBarrier;
    return [];
  }

  async *readData(_token: string): AsyncIterable<Uint8Array> {
    throw new Error("folders have no data");
  }

  destroy(): void {}
}

class DeepFolderRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "plan";

  constructor(readonly depth: number) {}

  getEntry(token: string): ArchiveEntrySummary {
    return this.describeRestoreItem(token).entry;
  }

  restoreIdentity(token: string): string {
    return `deep-${token}`;
  }

  describeRestoreItem(token: string): RestoreItemDescriptor {
    const index = Number(token.slice("folder-".length));
    if (!Number.isInteger(index) || index < 0 || index >= this.depth) throw new Error(`unknown token ${token}`);
    return {
      entry: {
        token,
        name: token,
        kind: "folder",
        size: 0,
        modifiedAt: new Date(0).toISOString(),
        mode: 0o040500,
        containedFiles: 0,
      },
      identity: this.restoreIdentity(token),
      modifiedSeconds: 0,
      modifiedNanoseconds: 0,
    };
  }

  async listChildren(token: string): Promise<ArchiveEntrySummary[]> {
    const index = Number(token.slice("folder-".length));
    return index + 1 < this.depth ? [this.getEntry(`folder-${index + 1}`)] : [];
  }

  async *readData(_token: string): AsyncIterable<Uint8Array> {
    throw new Error("folders have no data");
  }

  destroy(): void {}
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

function chmodWithSpecialBits(path: string, mode: number): void {
  const result = Bun.spawnSync({
    cmd: ["/bin/chmod", (mode & 0o7777).toString(8).padStart(4, "0"), path],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
}
