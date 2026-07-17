export type ConnectionSummary = {
  id: number;
  label: string;
  provider: "b2";
};

export type CloudBucket = {
  connectionId: number;
  connectionLabel: string;
  id: string;
  name: string;
};

export type AppStatus = {
  ready: boolean;
  databasePath: string;
  connections: ConnectionSummary[];
};

export type ArchiveProbe = {
  state: "supported" | "empty" | "unsupported" | "locked";
  format: "arq-legacy" | "arq5" | "arq7" | "mixed" | null;
  message: string;
  plans: BackupPlanSummary[];
};

export type BackupPlanSummary = {
  id: string;
  name: string;
  locked: boolean;
  format: "arq-legacy" | "arq5" | "arq7";
  recordCount?: number;
};

export type ArchiveEntrySummary = {
  token: string;
  name: string;
  kind: "file" | "folder" | "symlink";
  size: number;
  modifiedAt: string;
  mode: number;
  containedFiles: number;
};

export type BackupRecordSummary = {
  id: string;
  createdAt: string;
  complete: boolean;
  root: ArchiveEntrySummary;
};

export type BackupFolderSummary = {
  id: string;
  name: string;
  localPath: string | null;
  latestRecord: BackupRecordSummary | null;
};

export type UnlockedArchive = {
  sessionId: string;
  folders: BackupFolderSummary[];
};

export type ArchiveSearchResult = ArchiveEntrySummary & {
  folderId: string;
  folderName: string;
  parentToken: string;
  parentPath: string;
  path: string;
};

export type ArchiveSearchResponse = {
  state: "indexing" | "ready" | "error";
  indexedEntries: number;
  scannedFolders: number;
  discoveredFolders: number;
  results: ArchiveSearchResult[];
  error: string | null;
};

export type RestoreJobState = "queued" | "expanding" | "running" | "completed" | "failed" | "canceled";

export type RestoreJobSummary = {
  id: string;
  name: string;
  kind: ArchiveEntrySummary["kind"];
  destinationPath: string;
  state: RestoreJobState;
  totalFiles: number;
  completedFiles: number;
  skippedFiles: number;
  totalBytes: number;
  completedBytes: number;
  currentPath: string | null;
  error: { path: string; message: string } | null;
  createdAt: string;
  finishedAt: string | null;
};

export type RestoreQueueSnapshot = {
  concurrency: number;
  activeWorkers: number;
  jobs: RestoreJobSummary[];
};

export type ApiErrorPayload = {
  error: {
    code: string;
    message: string;
  };
};
