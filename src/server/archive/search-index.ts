import type {
  ArchiveEntrySummary,
  ArchiveSearchResponse,
  ArchiveSearchResult,
  BackupFolderSummary,
} from "../../shared/contracts";
import { ArchiveFormatError } from "./common/errors";

const SEARCH_CONCURRENCY = 4;
const MAX_RESULTS = 200;
const MAX_DEPTH = 1_024;

type ChildReader = {
  listChildren(token: string): Promise<ArchiveEntrySummary[]>;
};

type IndexedEntry = {
  entry: ArchiveEntrySummary;
  folderId: string;
  folderName: string;
  parentToken: string;
  parentPath: string;
  path: string;
  relativePath: string;
  rootToken: string;
};

type IndexedFolder = {
  rootToken: string;
  relativePath: string;
  scanned: boolean;
};

type PendingFolder = {
  token: string;
  folderId: string;
  folderName: string;
  path: string;
  relativePath: string;
  rootToken: string;
  depth: number;
};

export class ArchiveSearchIndex {
  readonly #entries: IndexedEntry[] = [];
  readonly #indexedFolders = new Map<string, IndexedFolder>();
  #state: ArchiveSearchResponse["state"] = "indexing";
  #error: string | null = null;
  #started = false;
  #destroyed = false;

  constructor(
    readonly repository: ChildReader,
    readonly folders: BackupFolderSummary[],
  ) {}

  search(pattern: string, rootToken: string): ArchiveSearchResponse {
    if (!this.#started) {
      this.#started = true;
      void this.#build();
    }
    const scope = this.#indexedFolders.get(rootToken) ?? null;
    const progress = this.#progress(scope);
    const state = this.#state === "error"
      ? "error"
      : this.#state === "ready" || (scope !== null && progress.scannedFolders === progress.discoveredFolders)
        ? "ready"
        : "indexing";
    return {
      state,
      indexedEntries: scope ? this.#indexedEntryCount(scope) : 0,
      scannedFolders: progress.scannedFolders,
      discoveredFolders: progress.discoveredFolders,
      results: scope ? fnmatchEntries(pattern, this.#entries, scope, MAX_RESULTS) : [],
      error: this.#error,
    };
  }

  destroy(): void {
    this.#destroyed = true;
    this.#entries.length = 0;
    this.#indexedFolders.clear();
  }

  async #build(): Promise<void> {
    const pending: PendingFolder[] = this.folders.flatMap(folder => {
      const root = folder.latestRecord?.root;
      if (!root || root.kind !== "folder") return [];
      const pendingFolder = {
        token: root.token,
        folderId: folder.id,
        folderName: folder.name,
        path: folder.name,
        relativePath: "",
        rootToken: root.token,
        depth: 0,
      };
      this.#indexedFolders.set(root.token, { rootToken: root.token, relativePath: "", scanned: false });
      return [pendingFolder];
    });
    try {
      while (pending.length > 0 && !this.#destroyed) {
        const batch = pending.splice(0, SEARCH_CONCURRENCY);
        const groups = await Promise.all(batch.map(async parent => ({
          parent,
          children: await this.repository.listChildren(parent.token),
        })));
        if (this.#destroyed) return;
        for (const { parent, children } of groups) {
          const indexedParent = this.#indexedFolders.get(parent.token);
          if (indexedParent) indexedParent.scanned = true;
          if (parent.depth >= MAX_DEPTH && children.some(child => child.kind === "folder")) {
            throw new ArchiveFormatError("search_depth_exceeded", "The backup tree exceeds the search depth limit");
          }
          for (const entry of children) {
            const path = `${parent.path}/${entry.name}`;
            const relativePath = parent.relativePath ? `${parent.relativePath}/${entry.name}` : entry.name;
            this.#entries.push({
              entry,
              folderId: parent.folderId,
              folderName: parent.folderName,
              parentToken: parent.token,
              parentPath: parent.path,
              path,
              relativePath,
              rootToken: parent.rootToken,
            });
            if (entry.kind === "folder") {
              this.#indexedFolders.set(entry.token, {
                rootToken: parent.rootToken,
                relativePath,
                scanned: false,
              });
              pending.push({
                token: entry.token,
                folderId: parent.folderId,
                folderName: parent.folderName,
                path,
                relativePath,
                rootToken: parent.rootToken,
                depth: parent.depth + 1,
              });
            }
          }
        }
      }
      if (!this.#destroyed) this.#state = "ready";
    } catch (error) {
      if (this.#destroyed) return;
      this.#state = "error";
      this.#error = error instanceof Error ? error.message : "Backup search indexing failed.";
    }
  }

  #progress(scope: IndexedFolder | null): { scannedFolders: number; discoveredFolders: number } {
    let scannedFolders = 0;
    let discoveredFolders = 0;
    for (const folder of this.#indexedFolders.values()) {
      if (scope && !isPathWithinScope(folder.rootToken, folder.relativePath, scope)) continue;
      discoveredFolders += 1;
      if (folder.scanned) scannedFolders += 1;
    }
    return { scannedFolders, discoveredFolders };
  }

  #indexedEntryCount(scope: IndexedFolder): number {
    let count = 0;
    for (const entry of this.#entries) {
      if (pathWithinScope(entry.rootToken, entry.relativePath, scope) !== null) count += 1;
    }
    return count;
  }
}

export function fnmatchEntries(
  pattern: string,
  entries: IndexedEntry[],
  scope: Pick<IndexedFolder, "rootToken" | "relativePath">,
  limit = MAX_RESULTS,
): ArchiveSearchResult[] {
  const normalized = pattern.trim().replace(/^\/+/, "");
  if (!normalized) return [];
  const finalSlash = normalized.lastIndexOf("/");
  const filenamePattern = normalized.slice(finalSlash + 1);
  const implicitFilenameStars = filenamePattern.length > 0 && !hasGlobMagic(filenamePattern);
  const effectivePattern = implicitFilenameStars
    ? `${normalized.slice(0, finalSlash + 1)}*${filenamePattern}*`
    : normalized;
  const matcher = new Bun.Glob(effectivePattern);
  const matchesPath = normalized.includes("/");
  const matchesAnyComponent = !matchesPath && implicitFilenameStars;
  const matches: ArchiveSearchResult[] = [];
  for (const candidate of entries) {
    const scopedPath = pathWithinScope(candidate.rootToken, candidate.relativePath, scope);
    if (scopedPath === null) continue;
    const matched = matchesPath
      ? matcher.match(scopedPath)
      : matchesAnyComponent
        ? scopedPath.split("/").some(component => matcher.match(component))
        : matcher.match(candidate.entry.name);
    if (!matched) continue;
    matches.push({
      ...candidate.entry,
      folderId: candidate.folderId,
      folderName: candidate.folderName,
      parentToken: candidate.parentToken,
      parentPath: candidate.parentPath,
      path: candidate.path,
    });
  }
  return matches
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, limit);
}

function hasGlobMagic(pattern: string): boolean {
  return /[*?[{]/.test(pattern);
}

function pathWithinScope(
  rootToken: string,
  relativePath: string,
  scope: Pick<IndexedFolder, "rootToken" | "relativePath">,
): string | null {
  if (rootToken !== scope.rootToken) return null;
  if (!scope.relativePath) return relativePath;
  const prefix = `${scope.relativePath}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : null;
}

function isPathWithinScope(
  rootToken: string,
  relativePath: string,
  scope: Pick<IndexedFolder, "rootToken" | "relativePath">,
): boolean {
  return rootToken === scope.rootToken
    && (relativePath === scope.relativePath || pathWithinScope(rootToken, relativePath, scope) !== null);
}
