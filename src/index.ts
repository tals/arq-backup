import { serve } from "bun";
import index from "./index.html";
import { ArchiveSessionStore } from "./server/archive/arq7/session-store";
import { ProviderRegistry } from "./server/cloud/provider-registry";
import { appConfig } from "./server/config";
import { CredentialRepository } from "./server/credentials/credential-repository";
import {
  archiveProbe,
  cancelRestore,
  chooseRestoreDirectory,
  enqueueRestore,
  listArchiveChildren,
  listBuckets,
  lockArchiveSession,
  restoreQueueStatus,
  searchArchive,
  status,
  unlockArchive,
  updateRestoreQueue,
} from "./server/http";
import { RestoreQueue } from "./server/restore/queue";

process.umask(0o077);

const credentials = new CredentialRepository(appConfig.databasePath);
const providers = new ProviderRegistry(credentials);
const archiveSessions = new ArchiveSessionStore();
const restoreQueue = new RestoreQueue(archiveSessions);

const server = serve({
  hostname: appConfig.host,
  port: appConfig.port,
  routes: {
    "/*": index,
    "/api/status": request => status(providers, request),
    "/api/buckets": request => listBuckets(providers, request),
    "/api/buckets/:connectionId/:bucketId/archive": request =>
      archiveProbe(providers, request, request.params.connectionId, request.params.bucketId),
    "/api/archive/unlock": request => unlockArchive(providers, archiveSessions, request),
    "/api/archive/sessions/:sessionId/children": request =>
      listArchiveChildren(archiveSessions, request, request.params.sessionId),
    "/api/archive/sessions/:sessionId/search": request =>
      searchArchive(archiveSessions, request, request.params.sessionId),
    "/api/archive/sessions/:sessionId": request =>
      lockArchiveSession(archiveSessions, request, request.params.sessionId),
    "/api/restore/queue": request => request.method === "PATCH"
      ? updateRestoreQueue(restoreQueue, request)
      : restoreQueueStatus(restoreQueue, request),
    "/api/restore/jobs": request => enqueueRestore(restoreQueue, request),
    "/api/restore/jobs/:jobId/cancel": request =>
      cancelRestore(restoreQueue, request, request.params.jobId),
    "/api/restore/choose-directory": request => chooseRestoreDirectory(request),
  },

  development: !appConfig.production && {
    hmr: true,
    console: true,
  },
});

console.log(`Arq Restore is running at ${server.url}`);
console.log(`Credential database: ${appConfig.databasePath}`);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    restoreQueue.destroy();
    archiveSessions.destroy();
    credentials.close();
  });
} else {
  process.once("SIGINT", () => {
    restoreQueue.destroy();
    archiveSessions.destroy();
    credentials.close();
    server.stop();
    process.exit(0);
  });
}
