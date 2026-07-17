import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ApiError,
  cancelRestore,
  chooseRestoreDirectory,
  enqueueRestore,
  getArchiveChildren,
  getArchiveProbe,
  getBuckets,
  getRestoreQueue,
  getStatus,
  lockArchive,
  searchArchive,
  setRestoreConcurrency,
  unlockArchive,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  AppStatus,
  ArchiveEntrySummary,
  ArchiveProbe,
  ArchiveSearchResponse,
  ArchiveSearchResult,
  BackupFolderSummary,
  BackupPlanSummary,
  CloudBucket,
  RestoreQueueSnapshot,
  UnlockedArchive,
} from "@/shared/contracts";
import {
  ArchiveRestore,
  ArrowLeft,
  Box,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Cloud,
  Database,
  Download,
  FolderClock,
  FolderOpen,
  File,
  HardDrive,
  KeyRound,
  Link,
  ListRestart,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import "./index.css";

type Loadable<T> =
  | { state: "idle" | "loading"; value: T | null; error: null }
  | { state: "ready"; value: T; error: null }
  | { state: "error"; value: T | null; error: string };

const emptyStatus: Loadable<AppStatus> = { state: "loading", value: null, error: null };
const emptyBuckets: Loadable<CloudBucket[]> = { state: "idle", value: null, error: null };
const emptyRestoreQueue: RestoreQueueSnapshot = { concurrency: 4, activeWorkers: 0, jobs: [] };
type UnlockedSelection = { archive: UnlockedArchive; backupKey: string; generation: number };

export function App() {
  const [status, setStatus] = useState<Loadable<AppStatus>>(emptyStatus);
  const [buckets, setBuckets] = useState<Loadable<CloudBucket[]>>(emptyBuckets);
  const [selectedBucket, setSelectedBucket] = useState<CloudBucket | null>(null);
  const [probe, setProbe] = useState<Loadable<ArchiveProbe>>({ state: "idle", value: null, error: null });
  const [selectedPlan, setSelectedPlan] = useState<BackupPlanSummary | null>(null);
  const [unlockedSelection, setUnlockedSelection] = useState<UnlockedSelection | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState("");
  const [queueOpen, setQueueOpen] = useState(false);
  const [restoreQueue, setRestoreQueue] = useState<RestoreQueueSnapshot>(emptyRestoreQueue);
  const [restoreDestination, setRestoreDestination] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const selectedBucketIdentity = selectedBucket ? bucketKey(selectedBucket) : "";
  const selectedBackupKey = selectedBucket && selectedPlan ? backupKey(selectedBucket, selectedPlan) : "";
  const selectedBackupRef = useRef({ key: "", generation: 0 });
  if (selectedBackupRef.current.key !== selectedBackupKey) {
    selectedBackupRef.current = {
      key: selectedBackupKey,
      generation: selectedBackupRef.current.generation + 1,
    };
  }
  const selectionGeneration = selectedBackupRef.current.generation;
  const unlockedArchive = unlockedSelection
    && unlockedSelection.backupKey === selectedBackupKey
    && unlockedSelection.generation === selectionGeneration
    ? unlockedSelection.archive
    : null;

  const refreshStatus = async () => {
    setStatus(previous => ({ state: "loading", value: previous.value, error: null }));
    try {
      const next = await getStatus();
      setStatus({ state: "ready", value: next, error: null });
      if (next.ready) await refreshBuckets();
      else setBuckets({ state: "ready", value: [], error: null });
    } catch (error) {
      setStatus({ state: "error", value: null, error: messageFor(error) });
    }
  };

  const refreshBuckets = async () => {
    setBuckets(previous => ({ state: "loading", value: previous.value, error: null }));
    try {
      const next = await getBuckets();
      setBuckets({ state: "ready", value: next, error: null });
      setSelectedBucket(current => current && next.find(bucket => bucketKey(bucket) === bucketKey(current)) || null);
    } catch (error) {
      setBuckets({ state: "error", value: null, error: messageFor(error) });
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    if (!selectedBucket) {
      setProbe({ state: "idle", value: null, error: null });
      setSelectedPlan(null);
      return;
    }
    const controller = new AbortController();
    setProbe({ state: "loading", value: null, error: null });
    setSelectedPlan(null);
    getArchiveProbe(selectedBucket, controller.signal)
      .then(value => setProbe({ state: "ready", value, error: null }))
      .catch(error => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setProbe({ state: "error", value: null, error: messageFor(error) });
      });
    return () => controller.abort();
  }, [selectedBucketIdentity]);

  useEffect(() => {
    setUnlockedSelection(null);
    setSelectedFolderId("");
  }, [selectedBackupKey]);

  const acceptUnlockedArchive = (archive: UnlockedArchive, sourceBackupKey: string, sourceGeneration: number) => {
    const selected = selectedBackupRef.current;
    if (selected.key !== sourceBackupKey || selected.generation !== sourceGeneration) {
      void lockArchive(archive.sessionId).catch(() => undefined);
      return;
    }
    setUnlockedSelection({ archive, backupKey: sourceBackupKey, generation: sourceGeneration });
    setSelectedFolderId(archive.folders.find(folder => folder.latestRecord)?.id ?? "");
  };

  useEffect(() => {
    const sessionId = unlockedSelection?.archive.sessionId;
    if (!sessionId) return;
    const release = () => void lockArchive(sessionId).catch(() => undefined);
    const releaseOnPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) release();
    };
    window.addEventListener("pagehide", releaseOnPageHide);
    return () => {
      window.removeEventListener("pagehide", releaseOnPageHide);
      release();
    };
  }, [unlockedSelection?.archive.sessionId]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await getRestoreQueue();
        if (stopped) return;
        setRestoreQueue(next);
        const active = next.jobs.some(job => job.state === "queued" || job.state === "expanding" || job.state === "running");
        timer = setTimeout(() => void poll(), queueOpen || active ? 700 : 2_500);
      } catch (error) {
        if (stopped) return;
        setRestoreError(messageFor(error));
        timer = setTimeout(() => void poll(), 2_500);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [queueOpen]);

  const refreshRestoreQueue = async () => {
    try {
      setRestoreQueue(await getRestoreQueue());
    } catch (error) {
      setRestoreError(messageFor(error));
    }
  };

  const pickRestoreDestination = async (): Promise<string | null> => {
    try {
      setRestoreError(null);
      const path = await chooseRestoreDirectory();
      if (path) setRestoreDestination(path);
      return path;
    } catch (error) {
      setRestoreError(messageFor(error));
      setQueueOpen(true);
      return null;
    }
  };

  const queueRestore = async (archive: UnlockedArchive, entry: ArchiveEntrySummary) => {
    let destination = restoreDestination.trim();
    if (!destination) destination = await pickRestoreDestination() ?? "";
    if (!destination) return;
    setQueueOpen(true);
    setRestoreError(null);
    try {
      await enqueueRestore(archive.sessionId, entry.token, destination);
      await refreshRestoreQueue();
    } catch (error) {
      setRestoreError(messageFor(error));
    }
  };

  const activeRestoreCount = restoreQueue.jobs.filter(job =>
    job.state === "queued" || job.state === "expanding" || job.state === "running"
  ).length;

  const filteredBuckets = useMemo(() => {
    const value = buckets.value ?? [];
    const query = filter.trim().toLocaleLowerCase();
    return query ? value.filter(bucket => bucket.name.toLocaleLowerCase().includes(query)) : value;
  }, [buckets.value, filter]);

  return (
    <div className="h-dvh min-h-[620px] bg-background text-foreground">
      <header className="flex h-14 items-center justify-between border-b bg-card/90 px-4 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <ArchiveRestore className="size-4.5" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight">Arq Restore</div>
            <div className="text-[11px] text-muted-foreground">Local recovery workspace</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-[11px] text-muted-foreground sm:flex">
            <ShieldCheck className="size-3.5 text-emerald-600" />
            Loopback only
          </div>
          <Button variant="outline" size="sm" onClick={() => setQueueOpen(true)}>
            <ListRestart /> Restore queue
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">{activeRestoreCount}</span>
          </Button>
        </div>
      </header>

      <div className="grid h-[calc(100dvh-3.5rem)] grid-cols-1 md:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="hidden min-h-0 flex-col border-r bg-sidebar md:flex">
          <div className="border-b p-3">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">B2 buckets</span>
              <Button variant="ghost" size="icon-sm" onClick={() => void refreshStatus()} aria-label="Refresh buckets">
                <RefreshCw className={cn(status.state === "loading" || buckets.state === "loading" ? "animate-spin" : "")} />
              </Button>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={event => setFilter(event.target.value)}
                placeholder="Filter buckets"
                className="h-8 bg-background pl-8 text-xs"
              />
            </div>
          </div>

          <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Cloud backups">
            <BucketNavigation
              buckets={filteredBuckets}
              loadState={buckets.state}
              error={buckets.error}
              selectedBucket={selectedBucket}
              selectedPlan={selectedPlan}
              probe={probe.value}
              unlockedArchive={unlockedArchive}
              selectedFolderId={selectedFolderId}
              onBucket={setSelectedBucket}
              onPlan={setSelectedPlan}
              onFolder={setSelectedFolderId}
            />
          </nav>

          <div className="border-t p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Database className="size-3.5" />
              <span className="truncate">{status.value?.connections.length ?? 0} imported connection{status.value?.connections.length === 1 ? "" : "s"}</span>
            </div>
          </div>
        </aside>

        <main className="min-w-0 overflow-y-auto bg-[radial-gradient(circle_at_top_right,var(--surface-glow),transparent_35%)]">
          <Workspace
            status={status}
            buckets={buckets}
            selectedBucket={selectedBucket}
            selectedPlan={selectedPlan}
            selectionGeneration={selectionGeneration}
            probe={probe}
            unlockedArchive={unlockedArchive}
            selectedFolderId={selectedFolderId}
            onSelectFolder={setSelectedFolderId}
            onRestore={entry => unlockedArchive && void queueRestore(unlockedArchive, entry)}
            onUnlocked={acceptUnlockedArchive}
            onLocked={sessionId => setUnlockedSelection(current =>
              current?.archive.sessionId === sessionId ? null : current
            )}
            onSelectPlan={setSelectedPlan}
            onRefresh={() => void refreshStatus()}
          />
        </main>
      </div>

      <QueuePanel
        open={queueOpen}
        queue={restoreQueue}
        destination={restoreDestination}
        error={restoreError}
        onDestination={setRestoreDestination}
        onChoose={() => void pickRestoreDestination()}
        onConcurrency={async value => {
          try {
            setRestoreError(null);
            setRestoreQueue(await setRestoreConcurrency(value));
          } catch (error) {
            setRestoreError(messageFor(error));
          }
        }}
        onCancel={async jobId => {
          try {
            setRestoreError(null);
            setRestoreQueue(await cancelRestore(jobId));
          } catch (error) {
            setRestoreError(messageFor(error));
          }
        }}
        onClose={() => setQueueOpen(false)}
      />
    </div>
  );
}

function BucketNavigation({
  buckets,
  loadState,
  error,
  selectedBucket,
  selectedPlan,
  probe,
  unlockedArchive,
  selectedFolderId,
  onBucket,
  onPlan,
  onFolder,
}: {
  buckets: CloudBucket[];
  loadState: Loadable<CloudBucket[]>["state"];
  error: string | null;
  selectedBucket: CloudBucket | null;
  selectedPlan: BackupPlanSummary | null;
  probe: ArchiveProbe | null;
  unlockedArchive: UnlockedArchive | null;
  selectedFolderId: string;
  onBucket: (bucket: CloudBucket) => void;
  onPlan: (plan: BackupPlanSummary) => void;
  onFolder: (folderId: string) => void;
}) {
  if ((loadState === "idle" || loadState === "loading") && buckets.length === 0) {
    return <SidebarMessage icon={<LoaderCircle className="animate-spin" />} text="Connecting to B2…" />;
  }
  if (error) return <SidebarMessage icon={<CircleAlert />} text={error} tone="error" />;
  if (buckets.length === 0) return <SidebarMessage icon={<Cloud />} text="No accessible buckets" />;

  return (
    <div className="space-y-1">
      {buckets.map(bucket => {
        const selected = selectedBucket && bucketKey(selectedBucket) === bucketKey(bucket);
        return (
          <div key={bucketKey(bucket)}>
            <button
              type="button"
              onClick={() => onBucket(bucket)}
              className={cn(
                "group flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
              )}
            >
              {selected ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
              <HardDrive className="size-4 text-sky-600" />
              <span className="min-w-0 flex-1 truncate font-medium">{bucket.name}</span>
            </button>
            {selected && probe?.plans.length ? (
              <div className="ml-[25px] border-l pl-2">
                {probe.plans.map(plan => (
                  <div key={plan.id}>
                    <button
                      type="button"
                      onClick={() => onPlan(plan)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                        selectedPlan?.id === plan.id ? "bg-sidebar-accent font-medium" : "text-muted-foreground hover:bg-sidebar-accent/60",
                      )}
                    >
                      <FolderClock className="size-3.5" />
                      <span className="truncate">{plan.name}</span>
                      {plan.locked && !(selectedPlan?.id === plan.id && unlockedArchive) ? <LockKeyhole className="ml-auto size-3" /> : null}
                    </button>
                    {selectedPlan?.id === plan.id && unlockedArchive ? (
                      <div className="ml-4 border-l pl-1.5">
                        {unlockedArchive.folders.map(folder => (
                          <button
                            key={folder.id}
                            type="button"
                            onClick={() => onFolder(folder.id)}
                            className={cn(
                              "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px]",
                              selectedFolderId === folder.id ? "bg-sidebar-accent font-medium" : "text-muted-foreground hover:bg-sidebar-accent/60",
                            )}
                          >
                            <FolderOpen className="size-3" /><span className="truncate">{folder.name}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Workspace({
  status,
  buckets,
  selectedBucket,
  selectedPlan,
  selectionGeneration,
  probe,
  unlockedArchive,
  selectedFolderId,
  onSelectFolder,
  onRestore,
  onUnlocked,
  onLocked,
  onSelectPlan,
  onRefresh,
}: {
  status: Loadable<AppStatus>;
  buckets: Loadable<CloudBucket[]>;
  selectedBucket: CloudBucket | null;
  selectedPlan: BackupPlanSummary | null;
  selectionGeneration: number;
  probe: Loadable<ArchiveProbe>;
  unlockedArchive: UnlockedArchive | null;
  selectedFolderId: string;
  onSelectFolder: (folderId: string) => void;
  onRestore: (entry: ArchiveEntrySummary) => void;
  onUnlocked: (archive: UnlockedArchive, sourceBackupKey: string, sourceGeneration: number) => void;
  onLocked: (sessionId: string) => void;
  onSelectPlan: (plan: BackupPlanSummary) => void;
  onRefresh: () => void;
}) {
  if (status.state === "loading" && !status.value) return <CenteredLoading label="Opening local workspace…" />;
  if (status.error) return <ErrorState title="Local server unavailable" message={status.error} onRetry={onRefresh} />;
  if (!status.value?.ready) return <SetupState databasePath={status.value?.databasePath} onRefresh={onRefresh} />;
  if (buckets.state === "loading" && !buckets.value) return <CenteredLoading label="Listing B2 buckets…" />;
  if (buckets.error) return <ErrorState title="Could not list B2 buckets" message={buckets.error} onRetry={onRefresh} />;
  if (!selectedBucket) return <WelcomeState bucketCount={buckets.value?.length ?? 0} />;

  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col px-5 py-5 lg:px-8">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>B2</span><ChevronRight className="size-3" /><span>{selectedBucket.connectionLabel}</span>
            {selectedPlan ? <><ChevronRight className="size-3" /><span className="max-w-52 truncate">{selectedPlan.name}</span></> : null}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{selectedPlan?.name ?? selectedBucket.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {selectedPlan ? "Encrypted backup plan" : `Bucket on ${selectedBucket.connectionLabel}`}
          </p>
        </div>
        <div className="rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm">
          Read-only cloud access
        </div>
      </div>

      {probe.state === "loading" || probe.state === "idle" ? <ArchiveLoading /> : null}
      {probe.error ? <ErrorState title="Could not inspect this bucket" message={probe.error} compact /> : null}
      {probe.value ? (
        <ArchiveContent
          probe={probe.value}
          bucket={selectedBucket}
          selectedPlan={selectedPlan}
          selectionGeneration={selectionGeneration}
          unlockedArchive={unlockedArchive}
          selectedFolderId={selectedFolderId}
          onSelectFolder={onSelectFolder}
          onRestore={onRestore}
          onSelectPlan={onSelectPlan}
          onUnlocked={onUnlocked}
          onLocked={onLocked}
        />
      ) : null}
    </div>
  );
}

function ArchiveContent({
  probe,
  bucket,
  selectedPlan,
  selectionGeneration,
  unlockedArchive,
  selectedFolderId,
  onSelectFolder,
  onRestore,
  onSelectPlan,
  onUnlocked,
  onLocked,
}: {
  probe: ArchiveProbe;
  bucket: CloudBucket;
  selectedPlan: BackupPlanSummary | null;
  selectionGeneration: number;
  unlockedArchive: UnlockedArchive | null;
  selectedFolderId: string;
  onSelectFolder: (folderId: string) => void;
  onRestore: (entry: ArchiveEntrySummary) => void;
  onSelectPlan: (plan: BackupPlanSummary) => void;
  onUnlocked: (archive: UnlockedArchive, sourceBackupKey: string, sourceGeneration: number) => void;
  onLocked: (sessionId: string) => void;
}) {
  if (probe.state === "empty" || probe.state === "unsupported") {
    return (
      <div className="grid min-h-[420px] place-items-center rounded-xl border border-dashed bg-card/50 p-8 text-center">
        <div className="max-w-md">
          <div className="mx-auto mb-4 grid size-12 place-items-center rounded-xl border bg-background shadow-sm">
            <Box className="size-5 text-muted-foreground" />
          </div>
          <h2 className="font-semibold">{probe.state === "empty" ? "Empty bucket" : "No Arq backups found"}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{probe.message}</p>
        </div>
      </div>
    );
  }

  if (selectedPlan && unlockedArchive) {
    return (
      <ArchiveBrowser
        archive={unlockedArchive}
        selectedFolderId={selectedFolderId}
        onSelectFolder={onSelectFolder}
        onRestore={onRestore}
        onLocked={onLocked}
      />
    );
  }

  if (selectedPlan) {
    return (
      <UnlockPlan
        key={`${backupKey(bucket, selectedPlan)}:${selectionGeneration}`}
        bucket={bucket}
        plan={selectedPlan}
        format={selectedPlan.format}
        selectionGeneration={selectionGeneration}
        onUnlocked={onUnlocked}
      />
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">Backup plans</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Newest Backup Record will open by default.</p>
        </div>
        {probe.format ? <span className="rounded bg-muted px-2 py-1 font-mono text-[10px] uppercase text-muted-foreground">{probe.format}</span> : null}
      </div>
      {probe.plans.length ? (
        <div className="divide-y">
          {probe.plans.map(plan => (
            <button
              key={plan.id}
              type="button"
              onClick={() => onSelectPlan(plan)}
              className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/40"
            >
              <div className="grid size-9 place-items-center rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                <FolderClock className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{plan.name}</div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{plan.id}</div>
              </div>
              <LockKeyhole className="size-4 text-muted-foreground" />
              <ChevronRight className="size-4 text-muted-foreground" />
            </button>
          ))}
        </div>
      ) : (
        <div className="p-8 text-center text-sm text-muted-foreground">{probe.message}</div>
      )}
    </section>
  );
}

function UnlockPlan({
  bucket,
  plan,
  format,
  selectionGeneration,
  onUnlocked,
}: {
  bucket: CloudBucket;
  plan: BackupPlanSummary;
  format: BackupPlanSummary["format"];
  selectionGeneration: number;
  onUnlocked: (archive: UnlockedArchive, sourceBackupKey: string, sourceGeneration: number) => void;
}) {
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (format === "arq-legacy") {
    return (
      <div className="grid flex-1 place-items-center py-10">
        <div className="w-full max-w-lg rounded-xl border bg-card p-6 shadow-sm">
          <div className="mb-5 grid size-11 place-items-center rounded-xl bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
            <FolderClock className="size-5" />
          </div>
          <h2 className="text-lg font-semibold">{plan.name}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            This older plan-layout archive is present in B2, but its browsing session is not connected yet.
          </p>
          <div className="mt-4 rounded-md bg-muted px-3 py-2 font-mono text-[11px] text-muted-foreground">{plan.id}</div>
        </div>
      </div>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError(null);
    try {
      onUnlocked(await unlockArchive(bucket, plan.id, format, password), backupKey(bucket, plan), selectionGeneration);
      setPassword("");
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="grid flex-1 place-items-center py-10">
      <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm">
        <div className="mb-5 grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground">
          <KeyRound className="size-5" />
        </div>
        <h2 className="text-lg font-semibold">Unlock {plan.name}</h2>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          The password and derived keys will remain only in Bun process memory for this session.
        </p>
        <form className="mt-5 space-y-3" onSubmit={submit}>
          <Input
            type="password"
            autoComplete="off"
            placeholder="Encryption password"
            aria-label="Encryption password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            disabled={working}
            autoFocus
          />
          {error ? <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">{error}</div> : null}
          <Button className="w-full" disabled={working}>
            {working ? <LoaderCircle className="animate-spin" /> : <LockKeyhole />}
            {working ? (format === "arq5" ? "Indexing legacy tree packs…" : "Opening backup…") : `Unlock ${format === "arq5" ? "legacy backup" : "Arq 7"}`}
          </Button>
        </form>
        <p className="mt-3 text-center text-[11px] text-muted-foreground">Nothing entered here is written to disk.</p>
      </div>
    </div>
  );
}

type BrowseLevel = { title: string; token: string; entry: ArchiveEntrySummary | null; entries: ArchiveEntrySummary[] };

function ArchiveBrowser({
  archive,
  selectedFolderId,
  onSelectFolder,
  onRestore,
  onLocked,
}: {
  archive: UnlockedArchive;
  selectedFolderId: string;
  onSelectFolder: (folderId: string) => void;
  onRestore: (entry: ArchiveEntrySummary) => void;
  onLocked: (sessionId: string) => void;
}) {
  const availableFolders = archive.folders.filter(folder => folder.latestRecord !== null);
  const [levels, setLevels] = useState<BrowseLevel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResponse, setSearchResponse] = useState<ArchiveSearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const suppressNextRoot = useRef<string | null>(null);
  const selectedFolder = availableFolders.find(folder => folder.id === selectedFolderId) ?? null;
  const current = levels.at(-1);
  const searchRootToken = current?.token ?? selectedFolder?.latestRecord?.root.token ?? "";

  const openRoot = async (folder: BackupFolderSummary) => {
    const root = folder.latestRecord?.root;
    if (!root) return;
    setSearchQuery("");
    setLevels([]);
    setLoading(true);
    setError(null);
    try {
      const entries = root.kind === "folder" ? await getArchiveChildren(archive.sessionId, root.token) : [root];
      setLevels([{ title: root.name, token: root.token, entry: root, entries }]);
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (suppressNextRoot.current === selectedFolderId) {
      suppressNextRoot.current = null;
      return;
    }
    const folder = availableFolders.find(candidate => candidate.id === selectedFolderId);
    if (folder) void openRoot(folder);
  }, [selectedFolderId, archive.sessionId]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query || !searchRootToken) {
      setSearchResponse(null);
      setSearchError(null);
      return;
    }
    setSearchResponse(null);
    setSearchError(null);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      try {
        const response = await searchArchive(archive.sessionId, query, searchRootToken, controller.signal);
        setSearchResponse(response);
        setSearchError(null);
        if (response.state === "indexing") timer = setTimeout(() => void run(), 800);
      } catch (nextError) {
        if (nextError instanceof DOMException && nextError.name === "AbortError") return;
        setSearchError(messageFor(nextError));
      }
    };
    const debounce = setTimeout(() => void run(), 180);
    return () => {
      controller.abort();
      clearTimeout(debounce);
      if (timer) clearTimeout(timer);
    };
  }, [searchQuery, searchRootToken, archive.sessionId]);

  const openEntry = async (entry: ArchiveEntrySummary) => {
    if (entry.kind !== "folder") return;
    setLoading(true);
    setError(null);
    try {
      const entries = await getArchiveChildren(archive.sessionId, entry.token);
      setLevels(previous => [...previous, { title: entry.name, token: entry.token, entry, entries }]);
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setLoading(false);
    }
  };

  const lock = async () => {
    try {
      await lockArchive(archive.sessionId);
    } finally {
      onLocked(archive.sessionId);
    }
  };

  const openSearchResult = async (result: ArchiveSearchResult) => {
    setLoading(true);
    setError(null);
    try {
      const entries = await getArchiveChildren(archive.sessionId, result.parentToken);
      if (result.folderId !== selectedFolderId) {
        suppressNextRoot.current = result.folderId;
        onSelectFolder(result.folderId);
      }
      setLevels([{ title: result.parentPath, token: result.parentToken, entry: null, entries }]);
      setSearchQuery("");
    } catch (nextError) {
      setSearchError(messageFor(nextError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {levels.length > 1 ? (
            <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={() => setLevels(previous => previous.slice(0, -1))}>
              <ArrowLeft />
            </Button>
          ) : null}
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{current?.title ?? selectedFolder?.name ?? "Backup files"}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {selectedFolder?.latestRecord ? `Backup Record ${formatDate(selectedFolder.latestRecord.createdAt)}` : "No Backup Record"}
            </div>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-end gap-2">
          <div className="relative min-w-44 max-w-80 flex-1">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder="foo, *.pdf, **/Photos/*"
              aria-label={`Search recursively from ${current?.title ?? selectedFolder?.name ?? "current folder"}`}
              className="h-8 bg-background pl-8 text-xs"
            />
          </div>
          {availableFolders.length > 1 ? (
            <select
              className="h-8 max-w-56 rounded-md border bg-background px-2 text-xs"
              value={selectedFolderId}
              onChange={event => onSelectFolder(event.target.value)}
            >
              {availableFolders.map(folder => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
            </select>
          ) : null}
          {current?.entry ? (
            <Button variant="outline" size="sm" onClick={() => onRestore(current.entry!)}><Download /> Restore folder</Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => void lock()}><LockKeyhole /> Lock</Button>
        </div>
      </div>
      {error ? <div className="border-b bg-destructive/10 px-4 py-3 text-xs text-destructive">{error}</div> : null}
      {searchError ? <div className="border-b bg-destructive/10 px-4 py-3 text-xs text-destructive">{searchError}</div> : null}
      {searchQuery.trim() ? (
        <ArchiveSearchResults
          query={searchQuery}
          response={searchResponse}
          onOpen={result => void openSearchResult(result)}
          onRestore={onRestore}
        />
      ) : null}
      {loading && !current ? <CenteredLoading label="Decrypting folder tree…" /> : null}
      {!searchQuery.trim() && !loading && availableFolders.length === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">No Backup Records were found in this plan.</div>
      ) : null}
      {!searchQuery.trim() && current ? (
        <div className="min-h-80 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/35 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-4 py-2.5 font-medium">Name</th><th className="px-4 py-2.5 font-medium">Modified</th><th className="px-4 py-2.5 text-right font-medium">Size</th><th className="px-4 py-2.5 text-right font-medium">Restore</th></tr>
            </thead>
            <tbody className="divide-y">
              {current.entries.map(entry => (
                <tr
                  key={entry.token}
                  className={cn("transition-colors", entry.kind === "folder" && "cursor-pointer hover:bg-muted/40")}
                  onDoubleClick={() => void openEntry(entry)}
                >
                  <td className="max-w-lg px-4 py-3">
                    <button
                      type="button"
                      disabled={entry.kind !== "folder"}
                      onClick={() => void openEntry(entry)}
                      className="flex max-w-full items-center gap-2 text-left disabled:cursor-default"
                    >
                      <EntryIcon kind={entry.kind} />
                      <span className="truncate font-medium">{entry.name}</span>
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">{formatDate(entry.modifiedAt)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs text-muted-foreground">{entry.kind === "folder" ? `${entry.containedFiles.toLocaleString()} files` : formatBytes(entry.size)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={event => { event.stopPropagation(); onRestore(entry); }}
                      aria-label={`Queue Restore for ${entry.name}`}
                    ><Download /> Queue</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading ? <div className="flex items-center gap-2 border-t px-4 py-3 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Decrypting folder tree…</div> : null}
          {!loading && current.entries.length === 0 ? <div className="p-10 text-center text-sm text-muted-foreground">This folder is empty.</div> : null}
        </div>
      ) : null}
    </section>
  );
}

function ArchiveSearchResults({
  query,
  response,
  onOpen,
  onRestore,
}: {
  query: string;
  response: ArchiveSearchResponse | null;
  onOpen: (result: ArchiveSearchResult) => void;
  onRestore: (result: ArchiveSearchResult) => void;
}) {
  if (!response) return <CenteredLoading label="Starting backup search…" />;
  const progress = response.state === "ready"
    ? 100
    : response.discoveredFolders > 0
      ? Math.min(99, Math.round(response.scannedFolders / response.discoveredFolders * 100))
      : 0;
  return (
    <div className="min-h-80 overflow-x-auto">
      <div className="space-y-2 border-b bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
        <div className="flex items-center justify-between gap-4">
          <span>{response.results.length} match{response.results.length === 1 ? "" : "es"} for “{query.trim()}”</span>
          <span className="flex items-center gap-1.5 tabular-nums">
            {response.state === "indexing" ? <LoaderCircle className="size-3 animate-spin" /> : null}
            {response.indexedEntries.toLocaleString()} items · {response.scannedFolders.toLocaleString()} / {response.discoveredFolders.toLocaleString()} discovered folders
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Recursive search indexing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${progress}%` }} />
        </div>
      </div>
      {response.error ? <div className="border-b bg-destructive/10 px-4 py-3 text-xs text-destructive">{response.error}</div> : null}
      <table className="w-full text-left text-sm">
        <thead className="border-b bg-muted/35 text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr><th className="px-4 py-2.5 font-medium">Match</th><th className="px-4 py-2.5 font-medium">Modified</th><th className="px-4 py-2.5 text-right font-medium">Size</th><th className="px-4 py-2.5 text-right font-medium">Restore</th></tr>
        </thead>
        <tbody className="divide-y">
          {response.results.map(result => (
            <tr key={`${result.folderId}:${result.token}`} className="cursor-pointer transition-colors hover:bg-muted/40" onClick={() => onOpen(result)}>
              <td className="max-w-2xl px-4 py-3">
                <div className="flex items-center gap-2"><EntryIcon kind={result.kind} /><span className="truncate font-medium">{result.name}</span></div>
                <div className="mt-1 truncate pl-6 font-mono text-[10px] text-muted-foreground">{result.path}</div>
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">{formatDate(result.modifiedAt)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-xs text-muted-foreground">{result.kind === "folder" ? "Folder" : formatBytes(result.size)}</td>
              <td className="whitespace-nowrap px-4 py-2 text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={event => { event.stopPropagation(); onRestore(result); }}
                  aria-label={`Queue Restore for ${result.name}`}
                ><Download /> Queue</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {response.results.length === 0 && response.state === "ready" ? (
        <div className="p-10 text-center text-sm text-muted-foreground">No filenames or paths match this wildcard pattern.</div>
      ) : null}
      {response.results.length === 0 && response.state === "indexing" ? (
        <div className="p-10 text-center text-sm text-muted-foreground">Searching decrypted folder trees…</div>
      ) : null}
    </div>
  );
}

function EntryIcon({ kind }: { kind: ArchiveEntrySummary["kind"] }) {
  if (kind === "folder") return <FolderOpen className="size-4 shrink-0 text-sky-600" />;
  if (kind === "symlink") return <Link className="size-4 shrink-0 text-violet-600" />;
  return <File className="size-4 shrink-0 text-muted-foreground" />;
}

function SetupState({ databasePath, onRefresh }: { databasePath?: string; onRefresh: () => void }) {
  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border bg-card shadow-sm">
        <div className="border-b p-7">
          <div className="mb-5 grid size-12 place-items-center rounded-xl bg-sky-600 text-white shadow-sm">
            <Server className="size-5" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Import your B2 connection</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            Arq keeps storage credentials in a root-only store. Run the dedicated importer once, then refresh this local workspace.
          </p>
        </div>
        <div className="space-y-4 p-7">
          <div className="rounded-lg border bg-zinc-950 p-4 font-mono text-xs text-zinc-100 shadow-inner">
            <span className="select-none text-zinc-500">$ </span>sudo "$(command -v bun)" run import:arq
          </div>
          <div className="flex items-start gap-3 rounded-lg bg-muted/60 p-3 text-xs leading-5 text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            Only B2 credentials are imported. Encryption passwords, master keys, and derived keys are never persisted.
          </div>
          {databasePath ? <div className="truncate text-[11px] text-muted-foreground">Database: {databasePath}</div> : null}
          <Button variant="outline" onClick={onRefresh}><RefreshCw /> Refresh connections</Button>
        </div>
      </div>
    </div>
  );
}

function WelcomeState({ bucketCount }: { bucketCount: number }) {
  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="max-w-lg text-center">
        <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl border bg-card shadow-sm">
          <Cloud className="size-6 text-sky-600" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Choose a B2 bucket</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {bucketCount} accessible bucket{bucketCount === 1 ? " is" : "s are"} ready. Select one from the sidebar to look for Arq backup plans.
        </p>
      </div>
    </div>
  );
}

function QueuePanel({
  open,
  queue,
  destination,
  error,
  onDestination,
  onChoose,
  onConcurrency,
  onCancel,
  onClose,
}: {
  open: boolean;
  queue: RestoreQueueSnapshot;
  destination: string;
  error: string | null;
  onDestination: (path: string) => void;
  onChoose: () => void;
  onConcurrency: (value: number) => void;
  onCancel: (jobId: string) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[1px]" onMouseDown={onClose}>
      <aside
        className="absolute inset-y-0 right-0 flex w-full max-w-lg flex-col border-l bg-card shadow-2xl"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="flex h-14 items-center justify-between border-b px-4">
          <div>
            <div className="text-sm font-semibold">Restore queue</div>
            <div className="text-[11px] text-muted-foreground">Session only · {queue.activeWorkers} active / {queue.concurrency} workers</div>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close restore queue"><X /></Button>
        </div>
        <div className="space-y-2 border-b p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Destination for new jobs</div>
          <div className="flex gap-2">
            <Input
              value={destination}
              onChange={event => onDestination(event.target.value)}
              placeholder="/absolute/local/path"
              aria-label="Restore destination directory"
              className="h-8 font-mono text-xs"
            />
            <Button variant="outline" size="sm" onClick={onChoose}><FolderOpen /> Choose…</Button>
          </div>
          <p className="text-[10px] leading-4 text-muted-foreground">Matching size + timestamp files are skipped. Mismatches are atomically overwritten.</p>
        </div>
        {error ? <div className="border-b bg-destructive/10 px-4 py-3 text-xs leading-5 text-destructive">{error}</div> : null}
        {queue.jobs.length === 0 ? (
          <div className="grid flex-1 place-items-center p-8 text-center">
            <div className="max-w-xs">
              <ListRestart className="mx-auto mb-3 size-8 text-muted-foreground/60" />
              <div className="text-sm font-medium">The queue is empty</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Queue a File or Folder from the backup browser or search results.</p>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {queue.jobs.map(job => {
              const active = job.state === "queued" || job.state === "expanding" || job.state === "running";
              const progress = job.totalBytes > 0
                ? Math.min(100, Math.round(job.completedBytes / job.totalBytes * 100))
                : job.state === "completed" ? 100 : 0;
              return (
                <div key={job.id} className="rounded-lg border bg-background p-3 shadow-sm">
                  <div className="flex items-start gap-2">
                    <EntryIcon kind={job.kind} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{job.name}</div>
                      <div className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground">{job.destinationPath}</div>
                    </div>
                    <span className={cn(
                      "rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
                      job.state === "failed" ? "bg-destructive/10 text-destructive" :
                        job.state === "completed" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" :
                          job.state === "canceled" ? "bg-muted text-muted-foreground" : "bg-sky-500/10 text-sky-700 dark:text-sky-300",
                    )}>{job.state}</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                    <div className={cn("h-full rounded-full", job.state === "failed" ? "bg-destructive" : "bg-primary")} style={{ width: `${progress}%` }} />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                    <span>{job.completedFiles.toLocaleString()} / {job.totalFiles.toLocaleString()} files · {job.skippedFiles.toLocaleString()} skipped</span>
                    <span>{formatBytes(job.completedBytes)} / {formatBytes(job.totalBytes)}</span>
                  </div>
                  {job.currentPath ? <div className="mt-1 truncate font-mono text-[9px] text-muted-foreground">{job.currentPath}</div> : null}
                  {job.error ? (
                    <div className="mt-2 rounded bg-destructive/10 px-2 py-1.5 text-[10px] leading-4 text-destructive">
                      <div className="break-all font-mono">{job.error.path}</div>
                      <div>{job.error.message}</div>
                    </div>
                  ) : null}
                  {active ? <Button className="mt-2" variant="ghost" size="sm" onClick={() => onCancel(job.id)}><X /> Cancel</Button> : null}
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><Settings2 className="size-3.5" /> Worker concurrency</span>
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs font-medium text-foreground"
            value={queue.concurrency}
            onChange={event => onConcurrency(Number(event.target.value))}
          >
            {[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
      </aside>
    </div>
  );
}

function ArchiveLoading() {
  return (
    <div className="space-y-3 rounded-xl border bg-card p-5 shadow-sm">
      <div className="h-4 w-36 animate-pulse rounded bg-muted" />
      <div className="h-14 animate-pulse rounded-lg bg-muted/70" />
      <div className="h-14 animate-pulse rounded-lg bg-muted/50" />
    </div>
  );
}

function CenteredLoading({ label }: { label: string }) {
  return <div className="grid min-h-full place-items-center text-sm text-muted-foreground"><div className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" />{label}</div></div>;
}

function ErrorState({ title, message, onRetry, compact = false }: { title: string; message: string; onRetry?: () => void; compact?: boolean }) {
  return (
    <div className={cn("grid place-items-center p-6", compact ? "min-h-72 rounded-xl border bg-card" : "min-h-full")}>
      <div className="max-w-md text-center">
        <CircleAlert className="mx-auto mb-3 size-8 text-destructive" />
        <h2 className="font-semibold">{title}</h2>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{message}</p>
        {onRetry ? <Button className="mt-4" variant="outline" onClick={onRetry}><RefreshCw /> Try again</Button> : null}
      </div>
    </div>
  );
}

function SidebarMessage({ icon, text, tone = "muted" }: { icon: React.ReactNode; text: string; tone?: "muted" | "error" }) {
  return <div className={cn("flex items-start gap-2 rounded-md p-2 text-xs leading-5", tone === "error" ? "text-destructive" : "text-muted-foreground")}><span className="mt-0.5 [&>svg]:size-3.5">{icon}</span>{text}</div>;
}

function bucketKey(bucket: CloudBucket): string {
  return `${bucket.connectionId}:${bucket.id}`;
}

function backupKey(bucket: CloudBucket, plan: BackupPlanSummary): string {
  return `${bucketKey(bucket)}:${plan.format}:${plan.id}`;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "An unexpected error occurred.";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatBytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let scaled = value;
  let index = -1;
  do {
    scaled /= 1_000;
    index += 1;
  } while (scaled >= 1_000 && index < units.length - 1);
  return `${scaled < 10 ? scaled.toFixed(1) : scaled.toFixed(0)} ${units[index]}`;
}

export default App;
