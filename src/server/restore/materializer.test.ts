import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, lutimes, mkdtemp, readFile, readlink, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchiveEntrySummary } from "../../shared/contracts";
import {
  finalizeRestoreDirectory,
  materializeRegularFile,
  materializeSymlink,
  partialFilePath,
} from "./materializer";
import type { RestoreItemDescriptor, RestoreSource } from "./source";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("Restore materializer", () => {
  test("skips a regular file with matching size and modification time without reading archive data", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "same.txt");
    const modified = new Date("2020-01-02T03:04:05.000Z");
    await writeFile(path, "same");
    await utimes(path, modified, modified);
    const source = new FakeSource(Buffer.from("same"));
    const item = descriptor("same.txt", "file", 4, modified, 0o100755);
    let progress = 0;

    expect(await materializeRegularFile(source, "token", path, item, callbacks(bytes => progress += bytes))).toEqual({ skipped: true });
    expect(source.reads).toBe(0);
    expect(progress).toBe(4);
    expect((await lstat(path)).mode & 0o777).toBe(0o755);
  });

  test("resumes a deterministic Partial File and atomically overwrites a mismatched file", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "report.txt");
    const modified = new Date("2021-06-07T08:09:10.000Z");
    const item = descriptor("report.txt", "file", 11, modified, 0o100640, "stable-report");
    await writeFile(path, "old");
    await writeFile(partialFilePath(path, item.identity), "hello");
    const source = new FakeSource(Buffer.from("hello world"), 5);
    let progress = 0;

    expect(await materializeRegularFile(source, "token", path, item, callbacks(bytes => progress += bytes))).toEqual({ skipped: false });
    expect(await readFile(path, "utf8")).toBe("hello world");
    expect(progress).toBe(11);
    expect(Math.trunc((await lstat(path)).mtimeMs)).toBe(modified.getTime());
    expect((await lstat(path)).mode & 0o777).toBe(0o640);
  });

  test("uses default file permissions when the archive has no permission bits", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "default.txt");
    const item = descriptor("default.txt", "file", 4, new Date(0), 0);

    expect(await materializeRegularFile(new FakeSource(Buffer.from("data")), "token", path, item, callbacks(() => undefined)))
      .toEqual({ skipped: false });
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
  });

  test("uses default file permissions when skipping a complete file with no archived permission bits", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "complete.txt");
    const modified = new Date("2020-01-02T03:04:05.000Z");
    await writeFile(path, "same");
    await chmod(path, 0o600);
    await utimes(path, modified, modified);
    const source = new FakeSource(Buffer.from("same"));
    const item = descriptor("complete.txt", "file", 4, modified, 0);

    expect(await materializeRegularFile(source, "token", path, item, callbacks(() => undefined)))
      .toEqual({ skipped: true });
    expect(source.reads).toBe(0);
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
  });

  test("validates an exact-size retained Partial File through archive EOF before promoting it", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "retry.txt");
    const item = descriptor("retry.txt", "file", 4, new Date(0), 0o100600, "exact-retry");
    const partialPath = partialFilePath(path, item.identity);
    await writeFile(path, "old");
    await writeFile(partialPath, "data");
    const source = new FakeSource(Buffer.from("data"), 4, true);

    await expect(materializeRegularFile(source, "token", path, item, callbacks(() => undefined)))
      .rejects.toThrow("injected trailing read failure");
    expect(source.reads).toBe(1);
    expect(await readFile(path, "utf8")).toBe("old");
    expect(await readFile(partialPath, "utf8")).toBe("data");
  });

  test("hard-errors when retained Partial File bytes differ from the archive", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "changed.txt");
    const item = descriptor("changed.txt", "file", 4, new Date(0), 0o100600, "changed-partial");
    const partialPath = partialFilePath(path, item.identity);
    await writeFile(partialPath, "evil");

    await expect(materializeRegularFile(new FakeSource(Buffer.from("good")), "token", path, item, callbacks(() => undefined)))
      .rejects.toThrow("differs from the archived data");
    expect(await readFile(partialPath, "utf8")).toBe("evil");
  });

  test("hard-errors and retains an oversized Partial File without touching the destination", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "keep.txt");
    const item = descriptor("keep.txt", "file", 4, new Date(0), 0o100600, "oversized");
    const partialPath = partialFilePath(path, item.identity);
    await writeFile(path, "old");
    await writeFile(partialPath, "too long");

    await expect(materializeRegularFile(new FakeSource(Buffer.from("data")), "token", path, item, callbacks(() => undefined)))
      .rejects.toThrow("larger than the archived");
    expect(await readFile(path, "utf8")).toBe("old");
    expect(await readFile(partialPath, "utf8")).toBe("too long");
  });

  test("restores a symlink target verbatim without following it", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "link");
    const target = Buffer.from("../outside/target");
    const item = descriptor("link", "symlink", target.byteLength, new Date("2022-01-01T00:00:00Z"), 0o120777);

    expect(await materializeSymlink(new FakeSource(target), "token", path, item, callbacks(() => undefined))).toEqual({ skipped: false });
    expect(await readlink(path, { encoding: "buffer" })).toEqual(target);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  test("replaces an equal-size, equal-time symlink whose target bytes differ", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "link");
    const modified = new Date("2022-01-01T00:00:00Z");
    const target = Buffer.from("../safe/b");
    const item = descriptor("link", "symlink", target.byteLength, modified, 0o120777);
    await symlink(Buffer.from("../safe/a"), path);
    await lutimes(path, modified, modified);

    expect(await materializeSymlink(new FakeSource(target), "token", path, item, callbacks(() => undefined))).toEqual({ skipped: false });
    expect(await readlink(path, { encoding: "buffer" })).toEqual(target);
  });

  test("uses sub-millisecond archive timestamps for matching and materialization", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "precise.txt");
    const item = descriptor("precise.txt", "file", 4, new Date("2020-09-13T12:26:40Z"));
    item.modifiedSeconds = 1_600_000_000;
    item.modifiedNanoseconds = 123_456_789;
    await writeFile(path, "evil");
    await utimes(path, 1_600_000_000.123, 1_600_000_000.123);
    const source = new FakeSource(Buffer.from("good"));

    expect(await materializeRegularFile(source, "token", path, item, callbacks(() => undefined))).toEqual({ skipped: false });
    expect(await readFile(path, "utf8")).toBe("good");
    const restored = await lstat(path, { bigint: true });
    expect(restored.mtimeNs % 1_000_000n).not.toBe(0n);

    const matchingSource = new FakeSource(Buffer.from("good"));
    expect(await materializeRegularFile(matchingSource, "token", path, item, callbacks(() => undefined))).toEqual({ skipped: true });
    expect(matchingSource.reads).toBe(0);
  });

  test("applies directory mode and timestamp after its contents", async () => {
    const root = await temporaryDirectory();
    const modified = new Date("2019-04-05T06:07:08Z");
    const item = descriptor("folder", "folder", 0, modified, 0o040750);
    await chmod(root, 0o700);
    await finalizeRestoreDirectory(root, item);
    const value = await lstat(root);
    expect(value.mode & 0o777).toBe(0o750);
    expect(Math.trunc(value.mtimeMs)).toBe(modified.getTime());
  });

  test("uses default directory permissions when the archive has no permission bits", async () => {
    const root = await temporaryDirectory();
    const item = descriptor("folder", "folder", 0, new Date(0), 0);
    await chmod(root, 0o700);

    await finalizeRestoreDirectory(root, item);

    expect((await lstat(root)).mode & 0o777).toBe(0o755);
  });
});

class FakeSource implements RestoreSource {
  reads = 0;

  constructor(
    readonly bytes: Uint8Array,
    readonly split = bytes.byteLength,
    readonly failAfterData = false,
  ) {}

  getEntry(_token: string): ArchiveEntrySummary {
    throw new Error("not used");
  }

  restoreIdentity(_token: string): string {
    return "fake";
  }

  describeRestoreItem(_token: string): RestoreItemDescriptor {
    throw new Error("not used");
  }

  async listChildren(_token: string): Promise<ArchiveEntrySummary[]> {
    return [];
  }

  async *readData(_token: string): AsyncIterable<Uint8Array> {
    this.reads += 1;
    if (this.split > 0) yield Uint8Array.from(this.bytes.subarray(0, this.split));
    if (this.split < this.bytes.byteLength) yield Uint8Array.from(this.bytes.subarray(this.split));
    if (this.failAfterData) throw new Error("injected trailing read failure");
  }
}

function descriptor(
  name: string,
  kind: ArchiveEntrySummary["kind"],
  size: number,
  modified: Date,
  mode = kind === "folder" ? 0o040755 : kind === "symlink" ? 0o120777 : 0o100600,
  identity = `identity-${name}`,
): RestoreItemDescriptor {
  return {
    entry: { token: "token", name, kind, size, modifiedAt: modified.toISOString(), mode, containedFiles: 0 },
    identity,
    modifiedSeconds: Math.floor(modified.getTime() / 1_000),
    modifiedNanoseconds: modified.getUTCMilliseconds() * 1_000_000,
  };
}

function callbacks(onBytes: (bytes: number) => void) {
  return { canceled: () => false, onBytes };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "arq-restore-materializer-"));
  temporaryDirectories.push(path);
  return path;
}
