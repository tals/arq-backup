import { describe, expect, test } from "bun:test";
import type { ArchiveEntrySummary, BackupFolderSummary } from "../../shared/contracts";
import { ArchiveSearchIndex } from "./search-index";

describe("session-only backup search", () => {
  test("indexes recursively and applies case-sensitive fnmatch wildcards", async () => {
    const nodes = new Map<string, ArchiveEntrySummary[]>([
      ["root", [entry("docs", "Documents", "folder"), entry("readme", "README.txt", "file")]],
      ["docs", [entry("report", "Annual Report 2024.pdf", "file"), entry("photo", "photo.jpg", "file")]],
    ]);
    const index = new ArchiveSearchIndex(
      { listChildren: async token => nodes.get(token) ?? [] },
      [folder("root")],
    );

    let response = index.search("*.pdf", "root");
    for (let attempt = 0; response.state === "indexing" && attempt < 20; attempt += 1) {
      await Promise.resolve();
      response = index.search("*.pdf", "root");
    }
    expect(response.state).toBe("ready");
    expect(response.indexedEntries).toBe(4);
    expect(response.scannedFolders).toBe(2);
    expect(response.discoveredFolders).toBe(2);
    expect(response.results.map(result => result.name)).toEqual(["Annual Report 2024.pdf"]);
    expect(response.results[0]).toMatchObject({
      folderId: "folder",
      parentToken: "docs",
      parentPath: "Home/Documents",
      path: "Home/Documents/Annual Report 2024.pdf",
    });

    expect(index.search("Documents/*.pdf", "root").results.map(result => result.name)).toEqual(["Annual Report 2024.pdf"]);
    const documentsResponse = index.search("*.pdf", "docs");
    expect(documentsResponse).toMatchObject({ indexedEntries: 2, scannedFolders: 1, discoveredFolders: 1 });
    expect(documentsResponse.results.map(result => result.name)).toEqual(["Annual Report 2024.pdf"]);
    expect(index.search("Documents/*.pdf", "docs").results).toEqual([]);
    expect(index.search("photo.???", "docs").results.map(result => result.name)).toEqual(["photo.jpg"]);
    expect(index.search("[Rr]*.txt", "root").results.map(result => result.name)).toEqual(["README.txt"]);
    expect(index.search("*.PDF", "root").results).toEqual([]);
    expect(index.search("anual*", "root").results).toEqual([]);
    index.destroy();
  });

  test("reports recursive folder-scan progress while deeper trees are pending", async () => {
    let releaseDocuments!: (entries: ArchiveEntrySummary[]) => void;
    const documents = new Promise<ArchiveEntrySummary[]>(resolve => {
      releaseDocuments = resolve;
    });
    const index = new ArchiveSearchIndex(
      {
        listChildren: async token => token === "root"
          ? [entry("docs", "Documents", "folder"), entry("readme", "README.txt", "file")]
          : documents,
      },
      [folder("root")],
    );

    let response = index.search("*", "root");
    for (let attempt = 0; response.scannedFolders === 0 && attempt < 20; attempt += 1) {
      await Promise.resolve();
      response = index.search("*", "root");
    }
    expect(response).toMatchObject({ state: "indexing", scannedFolders: 1, discoveredFolders: 2, indexedEntries: 2 });

    releaseDocuments([entry("report", "report.pdf", "file")]);
    for (let attempt = 0; response.state === "indexing" && attempt < 20; attempt += 1) {
      await Promise.resolve();
      response = index.search("*", "root");
    }
    expect(response).toMatchObject({ state: "ready", scannedFolders: 2, discoveredFolders: 2, indexedEntries: 3 });
    index.destroy();
  });

  test("implicitly wraps plain filenames and carries directory matches through descendants", async () => {
    const nodes = new Map<string, ArchiveEntrySummary[]>([
      ["root", [
        entry("pdf", "foo.pdf", "file"),
        entry("foobar", "foobar", "file"),
        entry("foo-dir", "foobar_dir", "folder"),
        entry("other-dir", "other_dir", "folder"),
      ]],
      ["foo-dir", [entry("bla", "bla", "file")]],
      ["other-dir", [entry("other", "unrelated.txt", "file")]],
    ]);
    const index = new ArchiveSearchIndex(
      { listChildren: async token => nodes.get(token) ?? [] },
      [folder("root")],
    );

    let response = index.search("foo", "root");
    for (let attempt = 0; response.state === "indexing" && attempt < 20; attempt += 1) {
      await Promise.resolve();
      response = index.search("foo", "root");
    }
    expect(response.results.map(result => result.path)).toEqual([
      "Home/foo.pdf",
      "Home/foobar",
      "Home/foobar_dir",
      "Home/foobar_dir/bla",
    ]);
    expect(index.search("*.pdf", "root").results.map(result => result.name)).toEqual(["foo.pdf"]);
    index.destroy();
  });
});

function entry(token: string, name: string, kind: ArchiveEntrySummary["kind"]): ArchiveEntrySummary {
  return {
    token,
    name,
    kind,
    size: kind === "file" ? 42 : 0,
    modifiedAt: "2024-01-01T00:00:00.000Z",
    mode: kind === "folder" ? 0o040755 : 0o100644,
    containedFiles: 0,
  };
}

function folder(rootToken: string): BackupFolderSummary {
  return {
    id: "folder",
    name: "Home",
    localPath: "/Users/example",
    latestRecord: {
      id: "record",
      createdAt: "2024-01-01T00:00:00.000Z",
      complete: true,
      root: entry(rootToken, "Home", "folder"),
    },
  };
}
