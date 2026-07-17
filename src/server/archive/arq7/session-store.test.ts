import { describe, expect, test } from "bun:test";
import type { ArchiveEntrySummary, CloudBucket } from "../../../shared/contracts";
import type { CloudStorageProvider } from "../../cloud/provider";
import { ArchiveSessionStore, type BrowsableArchiveRepository } from "./session-store";

describe("archive session ownership", () => {
  test("keeps concurrent sessions for the same plan independently addressable", () => {
    const store = new ArchiveSessionStore();
    const first = new FakeRepository();
    const second = new FakeRepository();
    const firstId = store.add(first, []);
    const secondId = store.add(second, []);

    expect(store.get(firstId)).toBe(first);
    expect(store.get(secondId)).toBe(second);
    store.remove(firstId);
    expect(first.destroyed).toBe(true);
    expect(store.get(secondId)).toBe(second);
    expect(second.destroyed).toBe(false);
    store.destroy();
  });

  test("keeps a detached repository alive until its restore lease is released", () => {
    const store = new ArchiveSessionStore();
    const repository = new FakeRepository();
    const id = store.add(repository, []);
    const lease = store.acquire(id);
    expect(lease?.repository).toBe(repository);

    store.remove(id);
    expect(store.get(id)).toBeNull();
    expect(repository.destroyed).toBe(false);
    lease?.release();
    expect(repository.destroyed).toBe(true);
    store.destroy();
  });
});

class FakeRepository implements BrowsableArchiveRepository {
  readonly provider = { connectionId: 1 } as CloudStorageProvider;
  readonly bucket = { id: "bucket" } as CloudBucket;
  readonly planId = "same-plan";
  destroyed = false;

  async listChildren(_token: string): Promise<ArchiveEntrySummary[]> {
    return [];
  }

  getEntry(_token: string): ArchiveEntrySummary {
    throw new Error("not used");
  }

  restoreIdentity(_token: string): string {
    return "fake";
  }

  describeRestoreItem(_token: string) {
    return {
      entry: {
        token: "fake",
        name: "fake",
        kind: "file" as const,
        size: 0,
        modifiedAt: new Date(0).toISOString(),
        mode: 0o100600,
        containedFiles: 0,
      },
      identity: "fake",
      modifiedSeconds: 0,
      modifiedNanoseconds: 0,
    };
  }

  async *readData(_token: string): AsyncIterable<Uint8Array> {}

  destroy(): void {
    this.destroyed = true;
  }
}
