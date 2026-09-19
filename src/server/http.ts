import type { ApiErrorPayload, ArchiveUnlockProgress, CloudBucket } from "../shared/contracts";
import { unlockArq5KeySet } from "./archive/arq5/crypto";
import { Arq5Repository } from "./archive/arq5/repository";
import { Arq6Repository } from "./archive/arq6/repository";
import { unlockArq7KeySet } from "./archive/arq7/crypto";
import { Arq7Repository } from "./archive/arq7/repository";
import type { ArchiveSessionStore } from "./archive/arq7/session-store";
import { ArchiveFormatError } from "./archive/common/errors";
import { probeArchive } from "./archive/probe";
import { CloudProviderError } from "./cloud/provider";
import { ProviderRegistry } from "./cloud/provider-registry";
import { appConfig } from "./config";
import { chooseLocalRestoreDirectory } from "./restore/directory-picker";
import type { RestoreQueue } from "./restore/queue";

const privateHeaders = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

export function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, {
    ...init,
    headers: { ...privateHeaders, ...init.headers },
  });
}

export function apiError(error: unknown): Response {
  if (error instanceof CloudProviderError) {
    return json({ error: { code: error.code, message: error.message } } satisfies ApiErrorPayload, {
      status: normalizeStatus(error.status),
    });
  }
  if (error instanceof ArchiveFormatError) {
    return json({ error: { code: error.code, message: error.message } } satisfies ApiErrorPayload, {
      status: error.code === "incorrect_password" ? 401 : 422,
    });
  }
  console.error("API request failed", error instanceof Error ? error.message : "Unknown error");
  return json(
    { error: { code: "internal_error", message: "The local server could not complete the request." } } satisfies ApiErrorPayload,
    { status: 500 },
  );
}

export async function unlockArchive(
  registry: ProviderRegistry,
  sessions: ArchiveSessionStore,
  request: Request,
): Promise<Response> {
  const forbidden = assertSameOrigin(request);
  if (forbidden) return forbidden;
  if (request.method !== "POST") return methodNotAllowed("POST");
  try {
    const body = await readObjectBody(request);
    const connectionId = requiredInteger(body, "connectionId");
    const bucketId = requiredString(body, "bucketId");
    const planId = requiredString(body, "planId");
    const password = requiredString(body, "password", true);
    const format = requiredString(body, "format");
    const provider = registry.provider(connectionId);
    if (!provider) return json({ error: { code: "missing_connection", message: "Connection not found." } }, { status: 404 });
    const bucket = (await provider.listBuckets()).find(candidate => candidate.id === bucketId);
    if (!bucket) return json({ error: { code: "missing_bucket", message: "Bucket not found." } }, { status: 404 });

    if (format === "arq5") {
      let publishProgress: (progress: ArchiveUnlockProgress) => void = () => undefined;
      const repository = await openArq5Repository(
        provider,
        bucket,
        planId,
        password,
        progress => publishProgress(progress),
      );
      return streamArq5Unlock(repository, sessions, listener => publishProgress = listener);
    }

    const repository = format === "arq6" || format === "arq7"
      ? new (format === "arq6" ? Arq6Repository : Arq7Repository)(
          provider,
          bucket,
          planId,
          await unlockArq7KeySet(await provider.readObject(bucket, `${planId}/encryptedkeyset.dat`), password),
        )
      : null;
    if (!repository) {
      return json({ error: { code: "unsupported_archive", message: "This archive format is not browsable yet." } }, { status: 422 });
    }
    try {
      const folders = await repository.listBackupFolders();
      const sessionId = sessions.add(repository, folders);
      return json({ sessionId, folders });
    } catch (error) {
      repository.destroy();
      throw error;
    }
  } catch (error) {
    return apiError(error);
  }
}

export async function listArchiveChildren(
  sessions: ArchiveSessionStore,
  request: Request,
  sessionId: string,
): Promise<Response> {
  const forbidden = assertSameOrigin(request);
  if (forbidden) return forbidden;
  if (request.method !== "GET") return methodNotAllowed("GET");
  try {
    const repository = sessions.get(sessionId);
    if (!repository) return json({ error: { code: "missing_session", message: "This archive is locked or the server restarted." } }, { status: 404 });
    const token = new URL(request.url).searchParams.get("token");
    if (!token) return json({ error: { code: "missing_node", message: "No archive folder was selected." } }, { status: 400 });
    return json({ entries: await repository.listChildren(token) });
  } catch (error) {
    return apiError(error);
  }
}

export function lockArchiveSession(
  sessions: ArchiveSessionStore,
  request: Request,
  sessionId: string,
): Response {
  const forbidden = assertSameOrigin(request);
  if (forbidden) return forbidden;
  if (request.method !== "DELETE") return methodNotAllowed("DELETE");
  sessions.remove(sessionId);
  return new Response(null, { status: 204, headers: privateHeaders });
}

export function searchArchive(
  sessions: ArchiveSessionStore,
  request: Request,
  sessionId: string,
): Response {
  const forbidden = assertSameOrigin(request);
  if (forbidden) return forbidden;
  if (request.method !== "GET") return methodNotAllowed("GET");
  const searchParams = new URL(request.url).searchParams;
  const query = searchParams.get("q")?.trim() ?? "";
  const rootToken = searchParams.get("root")?.trim() ?? "";
  if (!query) return json({ error: { code: "missing_query", message: "Enter a filename or path to search for." } }, { status: 400 });
  if (query.length > 512) return json({ error: { code: "query_too_long", message: "Search queries are limited to 512 characters." } }, { status: 400 });
  if (!rootToken) return json({ error: { code: "missing_search_root", message: "Open a folder before searching." } }, { status: 400 });
  const result = sessions.search(sessionId, query, rootToken);
  if (!result) return json({ error: { code: "missing_session", message: "This archive is locked or the server restarted." } }, { status: 404 });
  return json(result);
}

export function restoreQueueStatus(queue: RestoreQueue, request: Request): Response {
  const forbidden = assertSameOrigin(request);
  if (forbidden) return forbidden;
  if (request.method !== "GET") return methodNotAllowed("GET");
  return json(queue.snapshot());
}

export async function updateRestoreQueue(queue: RestoreQueue, request: Request): Promise<Response> {
  const forbidden = assertSameOrigin(request);
  if (forbidden) return forbidden;
  if (request.method !== "PATCH") return methodNotAllowed("PATCH");
  try {
    const body = await readObjectBody(request);
    return json(queue.setConcurrency(requiredInteger(body, "concurrency")));
  } catch (error) {
    return apiError(error);
  }
}

export async function enqueueRestore(queue: RestoreQueue, request: Request): Promise<Response> {
  const forbidden = assertSameOrigin(request);
  if (forbidden) return forbidden;
  if (request.method !== "POST") return methodNotAllowed("POST");
  try {
    const body = await readObjectBody(request);
    const job = queue.enqueue(
      requiredString(body, "sessionId"),
      requiredString(body, "token"),
      requiredString(body, "destinationDirectory"),
      requiredString(body, "relativePath"),
    );
    return json({ job }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}

export function cancelRestore(queue: RestoreQueue, request: Request, jobId: string): Response {
  const forbidden = assertSameOrigin(request);
  if (forbidden) return forbidden;
  if (request.method !== "POST") return methodNotAllowed("POST");
  try {
    return json(queue.cancel(jobId));
  } catch (error) {
    return apiError(error);
  }
}

export async function chooseRestoreDirectory(request: Request): Promise<Response> {
  const forbidden = assertSameOrigin(request);
  if (forbidden) return forbidden;
  if (request.method !== "POST") return methodNotAllowed("POST");
  try {
    return json({ path: await chooseLocalRestoreDirectory() });
  } catch (error) {
    return apiError(error);
  }
}

async function openArq5Repository(
  provider: NonNullable<ReturnType<ProviderRegistry["provider"]>>,
  bucket: CloudBucket,
  computerId: string,
  password: string,
  onUnlockProgress?: (progress: ArchiveUnlockProgress) => void,
): Promise<Arq5Repository> {
  let version: 2 | 3 = 3;
  let encrypted: Uint8Array;
  try {
    encrypted = await provider.readObject(bucket, `${computerId}/encryptionv3.dat`);
  } catch (error) {
    if (!(error instanceof CloudProviderError) || error.status !== 404) throw error;
    version = 2;
    encrypted = await provider.readObject(bucket, `${computerId}/encryptionv2.dat`);
  }
  const keySet = await unlockArq5KeySet(encrypted, password, version);
  return new Arq5Repository(provider, bucket, computerId, keySet, onUnlockProgress);
}

function streamArq5Unlock(
  repository: Arq5Repository,
  sessions: ArchiveSessionStore,
  attachProgress: (listener: (progress: ArchiveUnlockProgress) => void) => void,
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let sessionId: string | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      attachProgress(progress => send({ type: "progress", progress }));
      void (async () => {
        try {
          const folders = await repository.listBackupFolders();
          sessionId = sessions.add(repository, folders);
          send({ type: "complete", archive: { sessionId, folders } });
        } catch (error) {
          if (sessionId) sessions.remove(sessionId);
          else repository.destroy();
          const response = apiError(error);
          const payload = await response.json() as ApiErrorPayload;
          send({ type: "error", status: response.status, error: payload.error });
        } finally {
          if (!closed) {
            closed = true;
            controller.close();
          }
        }
      })();
    },
    cancel() {
      closed = true;
      if (sessionId) sessions.remove(sessionId);
      else repository.destroy();
    },
  });
  return new Response(stream, {
    headers: {
      ...privateHeaders,
      "Content-Type": "application/x-ndjson; charset=utf-8",
    },
  });
}

export function assertSameOrigin(request: Request): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const expected = new URL(request.url).origin;
  if (origin === expected) return null;
  return json({ error: { code: "forbidden_origin", message: "Cross-origin requests are not allowed." } }, { status: 403 });
}

export async function listBuckets(registry: ProviderRegistry, request: Request): Promise<Response> {
  const forbidden = assertSameOrigin(request);
  if (forbidden) return forbidden;
  try {
    return json({ buckets: await registry.listBuckets() });
  } catch (error) {
    return apiError(error);
  }
}

export async function archiveProbe(
  registry: ProviderRegistry,
  request: Request,
  connectionIdText: string,
  bucketId: string,
): Promise<Response> {
  const forbidden = assertSameOrigin(request);
  if (forbidden) return forbidden;
  try {
    const connectionId = Number.parseInt(connectionIdText, 10);
    if (!Number.isSafeInteger(connectionId)) return json({ error: { code: "bad_connection", message: "Invalid connection." } }, { status: 400 });
    const provider = registry.provider(connectionId);
    if (!provider) return json({ error: { code: "missing_connection", message: "Connection not found." } }, { status: 404 });
    const bucket = (await provider.listBuckets()).find(candidate => candidate.id === bucketId);
    if (!bucket) return json({ error: { code: "missing_bucket", message: "Bucket not found." } }, { status: 404 });
    return json({ probe: await probeArchive(provider, bucket) });
  } catch (error) {
    return apiError(error);
  }
}

export function status(registry: ProviderRegistry, request: Request): Response {
  const forbidden = assertSameOrigin(request);
  if (forbidden) return forbidden;
  const connections = registry.credentials.listConnections();
  return json({
    ready: connections.length > 0,
    databasePath: appConfig.databasePath,
    connections,
  });
}

function normalizeStatus(status: number): number {
  return status >= 400 && status <= 599 ? status : 502;
}

async function readObjectBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ArchiveFormatError("invalid_request", "The request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ArchiveFormatError("invalid_request", "The request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string, allowEmpty = false): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || (!allowEmpty && candidate.length === 0)) {
    throw new ArchiveFormatError("invalid_request", `${key} must be a string`);
  }
  return candidate;
}

function requiredInteger(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) {
    throw new ArchiveFormatError("invalid_request", `${key} must be an integer`);
  }
  return candidate;
}

function methodNotAllowed(method: string): Response {
  return json({ error: { code: "method_not_allowed", message: `Use ${method} for this endpoint.` } }, {
    status: 405,
    headers: { Allow: method },
  });
}
