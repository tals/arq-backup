import { randomUUID } from "node:crypto";
import type {
  ArchiveEntrySummary,
  ArchiveSearchResponse,
  BackupFolderSummary,
  CloudBucket,
} from "../../../shared/contracts";
import type { CloudStorageProvider } from "../../cloud/provider";
import { ArchiveSearchIndex } from "../search-index";
import type { RestoreSource } from "../../restore/source";

export interface BrowsableArchiveRepository extends RestoreSource {
  readonly provider: CloudStorageProvider;
  readonly bucket: CloudBucket;
  readonly planId: string;
  listChildren(token: string): Promise<ArchiveEntrySummary[]>;
  destroy(): void;
}

type StoredSession = {
  repository: BrowsableArchiveRepository;
  search: ArchiveSearchIndex;
  lastAccessedAt: number;
  browsing: boolean;
  leases: number;
};

export type ArchiveSessionLease = {
  repository: BrowsableArchiveRepository;
  release(): void;
};

const SESSION_IDLE_MILLISECONDS = 2 * 60 * 60 * 1_000;
const SWEEP_INTERVAL_MILLISECONDS = 60_000;

export class ArchiveSessionStore {
  readonly #sessions = new Map<string, StoredSession>();
  readonly #sweepTimer = setInterval(() => this.#sweepExpired(), SWEEP_INTERVAL_MILLISECONDS);

  constructor() {
    this.#sweepTimer.unref();
  }

  add(repository: BrowsableArchiveRepository, folders: BackupFolderSummary[]): string {
    this.#sweepExpired();
    const id = randomUUID();
    this.#sessions.set(id, {
      repository,
      search: new ArchiveSearchIndex(repository, folders),
      lastAccessedAt: Date.now(),
      browsing: true,
      leases: 0,
    });
    return id;
  }

  get(id: string): BrowsableArchiveRepository | null {
    const session = this.#sessions.get(id);
    if (!session?.browsing) return null;
    session.lastAccessedAt = Date.now();
    return session.repository;
  }

  search(id: string, query: string, rootToken: string): ArchiveSearchResponse | null {
    const session = this.#sessions.get(id);
    if (!session?.browsing) return null;
    session.lastAccessedAt = Date.now();
    return session.search.search(query, rootToken);
  }

  remove(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    session.search.destroy();
    session.browsing = false;
    if (session.leases === 0) this.#dispose(id, session);
  }

  acquire(id: string): ArchiveSessionLease | null {
    const session = this.#sessions.get(id);
    if (!session?.browsing) return null;
    session.lastAccessedAt = Date.now();
    session.leases += 1;
    let released = false;
    return {
      repository: session.repository,
      release: () => {
        if (released) return;
        released = true;
        session.leases -= 1;
        if (!session.browsing && session.leases === 0) this.#dispose(id, session);
      },
    };
  }

  destroy(): void {
    clearInterval(this.#sweepTimer);
    for (const session of this.#sessions.values()) {
      session.search.destroy();
      session.repository.destroy();
    }
    this.#sessions.clear();
  }

  #sweepExpired(): void {
    const cutoff = Date.now() - SESSION_IDLE_MILLISECONDS;
    for (const [id, session] of this.#sessions) {
      if (session.lastAccessedAt < cutoff) this.remove(id);
    }
  }

  #dispose(id: string, session: StoredSession): void {
    if (this.#sessions.get(id) !== session) return;
    session.search.destroy();
    session.repository.destroy();
    this.#sessions.delete(id);
  }
}
