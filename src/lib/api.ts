import type {
  ApiErrorPayload,
  AppStatus,
  ArchiveEntrySummary,
  ArchiveProbe,
  ArchiveSearchResponse,
  ArchiveUnlockProgress,
  CloudBucket,
  RestoreJobSummary,
  RestoreQueueSnapshot,
  UnlockedArchive,
} from "../shared/contracts";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function getStatus(signal?: AbortSignal): Promise<AppStatus> {
  return getJson<AppStatus>("/api/status", signal);
}

export async function getBuckets(signal?: AbortSignal): Promise<CloudBucket[]> {
  return (await getJson<{ buckets: CloudBucket[] }>("/api/buckets", signal)).buckets;
}

export async function getArchiveProbe(bucket: CloudBucket, signal?: AbortSignal): Promise<ArchiveProbe> {
  const connectionId = encodeURIComponent(String(bucket.connectionId));
  const bucketId = encodeURIComponent(bucket.id);
  return (await getJson<{ probe: ArchiveProbe }>(`/api/buckets/${connectionId}/${bucketId}/archive`, signal)).probe;
}

export async function unlockArchive(
  bucket: CloudBucket,
  planId: string,
  format: "arq5" | "arq6" | "arq7",
  password: string,
  onProgress?: (progress: ArchiveUnlockProgress) => void,
  signal?: AbortSignal,
): Promise<UnlockedArchive> {
  const response = await fetch("/api/archive/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId: bucket.connectionId, bucketId: bucket.id, planId, format, password }),
    signal,
    cache: "no-store",
  });
  if (!response.ok) await throwApiError(response);
  if (response.headers.get("Content-Type")?.includes("application/x-ndjson")) {
    return readUnlockStream(response, onProgress);
  }
  return (await response.json()) as UnlockedArchive;
}

export async function getArchiveChildren(
  sessionId: string,
  token: string,
  signal?: AbortSignal,
): Promise<ArchiveEntrySummary[]> {
  const path = `/api/archive/sessions/${encodeURIComponent(sessionId)}/children?token=${encodeURIComponent(token)}`;
  return (await requestJson<{ entries: ArchiveEntrySummary[] }>(path, { signal })).entries;
}

export async function searchArchive(
  sessionId: string,
  query: string,
  rootToken: string,
  signal?: AbortSignal,
): Promise<ArchiveSearchResponse> {
  const path = `/api/archive/sessions/${encodeURIComponent(sessionId)}/search?q=${encodeURIComponent(query)}&root=${encodeURIComponent(rootToken)}`;
  return requestJson<ArchiveSearchResponse>(path, { signal });
}

export async function lockArchive(sessionId: string): Promise<void> {
  const response = await fetch(`/api/archive/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    cache: "no-store",
    keepalive: true,
  });
  if (!response.ok) await throwApiError(response);
}

export function getRestoreQueue(signal?: AbortSignal): Promise<RestoreQueueSnapshot> {
  return getJson<RestoreQueueSnapshot>("/api/restore/queue", signal);
}

export function setRestoreConcurrency(concurrency: number): Promise<RestoreQueueSnapshot> {
  return requestJson<RestoreQueueSnapshot>("/api/restore/queue", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ concurrency }),
  });
}

export async function enqueueRestore(
  sessionId: string,
  token: string,
  destinationDirectory: string,
  relativePath: string,
): Promise<RestoreJobSummary> {
  return (await requestJson<{ job: RestoreJobSummary }>("/api/restore/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, token, destinationDirectory, relativePath }),
  })).job;
}

export function cancelRestore(jobId: string): Promise<RestoreQueueSnapshot> {
  return requestJson<RestoreQueueSnapshot>(`/api/restore/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
}

export async function chooseRestoreDirectory(): Promise<string | null> {
  return (await requestJson<{ path: string | null }>("/api/restore/choose-directory", { method: "POST" })).path;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(path, { signal });
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  if (!response.ok) {
    await throwApiError(response);
  }
  return (await response.json()) as T;
}

type ArchiveUnlockStreamEvent =
  | { type: "progress"; progress: ArchiveUnlockProgress }
  | { type: "complete"; archive: UnlockedArchive }
  | { type: "error"; status: number; error: ApiErrorPayload["error"] };

async function readUnlockStream(
  response: Response,
  onProgress?: (progress: ArchiveUnlockProgress) => void,
): Promise<UnlockedArchive> {
  if (!response.body) throw new ApiError("empty_unlock_stream", "The server returned no unlock result.", 500);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let archive: UnlockedArchive | null = null;

  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: ArchiveUnlockStreamEvent;
    try {
      event = JSON.parse(line) as ArchiveUnlockStreamEvent;
    } catch {
      throw new ApiError("invalid_unlock_stream", "The server returned invalid unlock progress.", 500);
    }
    if (event.type === "progress") onProgress?.(event.progress);
    else if (event.type === "complete") archive = event.archive;
    else if (event.type === "error") throw new ApiError(event.error.code, event.error.message, event.status);
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      processLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  processLine(buffer);
  if (!archive) throw new ApiError("incomplete_unlock_stream", "The unlock operation ended before it completed.", 500);
  return archive;
}

async function throwApiError(response: Response): Promise<never> {
  let payload: ApiErrorPayload | null = null;
  try {
    payload = (await response.json()) as ApiErrorPayload;
  } catch {
    // Keep a stable local error if the server response was not JSON.
  }
  throw new ApiError(
    payload?.error.code ?? `http_${response.status}`,
    payload?.error.message ?? `Request failed with HTTP ${response.status}`,
    response.status,
  );
}
