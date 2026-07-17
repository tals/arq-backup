import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../..");

export const appConfig = Object.freeze({
  host: "127.0.0.1",
  port: Number.parseInt(process.env.ARQ_RESTORE_PORT ?? "3217", 10),
  databasePath: resolve(process.env.ARQ_RESTORE_DB ?? resolve(projectRoot, "arq-restore.sqlite")),
  legacyTreePackCachePath: resolve(
    process.env.ARQ_RESTORE_LEGACY_CACHE ?? resolve(projectRoot, ".cache/legacy-tree-packs"),
  ),
  projectRoot,
  production: process.env.ARQ_RESTORE_ENV === "production",
});
