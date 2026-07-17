import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decryptLegacyObject } from "../archive/common/crypto";
import { ArchiveFormatError } from "../archive/common/errors";
import {
  CredentialRepository,
  type B2Credential,
  type ImportedB2Credential,
} from "../credentials/credential-repository";
import { openArqLocalKeySet } from "./arq-local-crypto";

export const ARQ_AGENT_ROOT = "/Library/Application Support/ArqAgent";
const SOURCE_DATABASE = join(ARQ_AGENT_ROOT, "server.db");
const LOCAL_KEY_SET = join(ARQ_AGENT_ROOT, "localkeysv2.dat");
const STORAGE_SECRETS = join(ARQ_AGENT_ROOT, "secrets", "storagelocation");

type StorageLocationRow = {
  id: number;
  json: string | null;
  active: number;
  provider_type: string;
};
type StorageLocation = {
  active?: boolean;
  displayDescription?: string;
  hasPassword?: boolean;
  name?: string;
  path?: string;
  providerType?: string;
  username?: string;
};

export type ImportedConnection = Pick<B2Credential, "id" | "label" | "bucketHint">;

export function importArqB2Credentials(
  outputDatabase: string,
  options: { dryRun?: boolean } = {},
): ImportedConnection[] {
  const prepared = readArqB2Credentials();
  if (options.dryRun) {
    return prepared.map((credential, index) => ({
      id: index + 1,
      label: credential.label,
      bucketHint: credential.bucketHint,
    }));
  }

  dropPrivilegesToSudoUser();
  assertSafeDatabasePath(outputDatabase);
  const destination = new CredentialRepository(outputDatabase);
  try {
    return destination.upsertB2Credentials(prepared).map(stored => ({
      id: stored.id,
      label: stored.label,
      bucketHint: stored.bucketHint,
    }));
  } finally {
    destination.close();
  }
}

function readArqB2Credentials(): ImportedB2Credential[] {
  const source = new Database(SOURCE_DATABASE, { readonly: true, strict: true });
  let localKeys: ReturnType<typeof openArqLocalKeySet> | null = null;
  try {
    localKeys = openArqLocalKeySet(readFileSync(LOCAL_KEY_SET));
    const rows = source
      .query<StorageLocationRow, []>("SELECT id, json, active, provider_type FROM storage_locations ORDER BY id")
      .all();
    const prepared: ImportedB2Credential[] = [];
    for (const row of rows) {
      let location: StorageLocation;
      try {
        location = parseStorageLocation(row);
      } catch (error) {
        if (row.active === 1 && row.provider_type.toLocaleLowerCase() === "b2") throw error;
        continue;
      }
      if (
        location.active !== true ||
        location.hasPassword !== true ||
        location.providerType?.toLocaleLowerCase() !== "b2"
      ) {
        continue;
      }
      if (!location.username?.trim()) {
        throw new Error(`Arq B2 storage location ${row.id} is missing its application key ID`);
      }

      const secretPath = join(STORAGE_SECRETS, String(row.id));
      const decodedSecret = decodeArqSecretFile(readFileSync(secretPath));
      let plaintext: Uint8Array | null = null;
      try {
        plaintext = decryptLegacyObject(decodedSecret, localKeys);
        const applicationKey = decodeUtf8(plaintext, `Arq B2 storage location ${row.id}`);
        prepared.push({
          label: location.name?.trim() || location.displayDescription?.trim() || "Arq B2",
          applicationKeyId: location.username.trim(),
          applicationKey,
          bucketHint: normalizeBucketHint(location.path),
        });
      } finally {
        decodedSecret.fill(0);
        plaintext?.fill(0);
      }
    }
    if (prepared.length === 0) throw new Error("No active B2 storage locations with credentials were found in Arq");
    return prepared;
  } finally {
    localKeys?.destroy();
    source.close();
  }
}

function dropPrivilegesToSudoUser(): void {
  const sudoUid = parseSudoId(process.env.SUDO_UID);
  const sudoGid = parseSudoId(process.env.SUDO_GID);
  if (sudoUid === null || sudoGid === null || sudoUid === 0 || sudoGid === 0) {
    throw new Error("A non-root SUDO_UID and SUDO_GID are required; run this command directly through sudo");
  }
  process.setgroups?.([]);
  process.setgid?.(sudoGid);
  process.setuid?.(sudoUid);
  if (process.getuid?.() !== sudoUid || process.getgid?.() !== sudoGid) {
    throw new Error("The importer could not drop root privileges before opening the destination database");
  }
}

function parseStorageLocation(row: StorageLocationRow): StorageLocation {
  if (!row.json) throw new Error(`Arq storage location ${row.id} has no JSON configuration`);
  try {
    const parsed = JSON.parse(row.json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as StorageLocation;
  } catch (error) {
    throw new Error(`Arq storage location ${row.id} contains invalid JSON`, { cause: error });
  }
}

function decodeArqSecretFile(file: Uint8Array): Uint8Array {
  const encoded = decodeUtf8(file, "Arq storage-location secret").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new ArchiveFormatError("invalid_local_secret", "Arq's storage-location secret is not valid Base64");
  }
  const decoded = Uint8Array.from(Buffer.from(encoded, "base64"));
  if (decoded.byteLength === 0 || Buffer.from(decoded).toString("base64") !== encoded) {
    decoded.fill(0);
    throw new ArchiveFormatError("invalid_local_secret", "Arq's storage-location secret is not canonical Base64");
  }
  return decoded;
}

function decodeUtf8(bytes: Uint8Array, description: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ArchiveFormatError("invalid_utf8", `${description} is not valid UTF-8`);
  }
}

function normalizeBucketHint(path: string | undefined): string | null {
  const value = path?.replace(/^\/+/, "").replace(/\/+$/, "").trim();
  return value || null;
}

function parseSudoId(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function assertSafeDatabasePath(path: string): void {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (realpathSync(parent) !== parent) {
    throw new Error(`Refusing to write the credential database through a symbolic-link directory: ${parent}`);
  }
  for (const candidate of [absolute, `${absolute}-shm`, `${absolute}-wal`]) {
    if (!existsSync(candidate)) continue;
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`Refusing unsafe credential database path: ${candidate}`);
    }
  }
}
