import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import type { ConnectionSummary } from "../../shared/contracts";

export type B2Credential = {
  id: number;
  label: string;
  applicationKeyId: string;
  applicationKey: string;
  bucketHint: string | null;
};

export type ImportedB2Credential = Omit<B2Credential, "id">;

type B2CredentialRow = {
  id: number;
  label: string;
  application_key_id: string;
  application_key: string;
  bucket_hint: string;
};

export class CredentialRepository {
  readonly #database: Database;

  constructor(readonly path: string) {
    this.#database = new Database(path, { create: true, strict: true });
    this.#database.run("PRAGMA journal_mode = WAL");
    this.#database.run("PRAGMA foreign_keys = ON");
    this.#database.run(`
      CREATE TABLE IF NOT EXISTS cloud_connections (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider = 'b2'),
        label TEXT NOT NULL,
        application_key_id TEXT NOT NULL,
        application_key TEXT NOT NULL,
        bucket_hint TEXT,
        imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(provider, application_key_id, bucket_hint)
      )
    `);
    this.#database.run("UPDATE cloud_connections SET bucket_hint = '' WHERE bucket_hint IS NULL");
    for (const candidate of [path, `${path}-shm`, `${path}-wal`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
  }

  listConnections(): ConnectionSummary[] {
    return this.#database
      .query<ConnectionSummary, []>(`
        SELECT id, label, provider
        FROM cloud_connections
        ORDER BY label COLLATE NOCASE, id
      `)
      .all();
  }

  listB2Credentials(): B2Credential[] {
    return this.#database
      .query<B2CredentialRow, []>(`
        SELECT id, label, application_key_id, application_key, bucket_hint
        FROM cloud_connections
        WHERE provider = 'b2'
        ORDER BY label COLLATE NOCASE, id
      `)
      .all()
      .map(row => ({
        id: row.id,
        label: row.label,
        applicationKeyId: row.application_key_id,
        applicationKey: row.application_key,
        bucketHint: row.bucket_hint || null,
      }));
  }

  getB2Credential(id: number): B2Credential | null {
    const row = this.#database
      .query<B2CredentialRow, [number]>(`
        SELECT id, label, application_key_id, application_key, bucket_hint
        FROM cloud_connections
        WHERE id = ? AND provider = 'b2'
      `)
      .get(id);

    return row
      ? {
          id: row.id,
          label: row.label,
          applicationKeyId: row.application_key_id,
          applicationKey: row.application_key,
          bucketHint: row.bucket_hint || null,
        }
      : null;
  }

  upsertB2Credential(credential: ImportedB2Credential): B2Credential {
    return this.upsertB2Credentials([credential])[0]!;
  }

  upsertB2Credentials(credentials: ImportedB2Credential[]): B2Credential[] {
    return this.#database.transaction((values: ImportedB2Credential[]) =>
      values.map(credential => this.#upsertB2Credential(credential))
    )(credentials);
  }

  #upsertB2Credential(credential: ImportedB2Credential): B2Credential {
    const bucketHint = credential.bucketHint ?? "";
    this.#database
      .query<never, [string, string, string, string]>(`
        INSERT INTO cloud_connections (
          provider,
          label,
          application_key_id,
          application_key,
          bucket_hint
        ) VALUES ('b2', ?, ?, ?, ?)
        ON CONFLICT(provider, application_key_id, bucket_hint) DO UPDATE SET
          label = excluded.label,
          application_key = excluded.application_key,
          imported_at = CURRENT_TIMESTAMP
      `)
      .run(
        credential.label,
        credential.applicationKeyId,
        credential.applicationKey,
        bucketHint,
      );

    const row = this.#database
      .query<B2CredentialRow, [string, string]>(`
        SELECT id, label, application_key_id, application_key, bucket_hint
        FROM cloud_connections
        WHERE provider = 'b2'
          AND application_key_id = ?
          AND bucket_hint = ?
      `)
      .get(credential.applicationKeyId, bucketHint);
    if (!row) throw new Error("The imported B2 connection could not be read back");
    return {
      id: row.id,
      label: row.label,
      applicationKeyId: row.application_key_id,
      applicationKey: row.application_key,
      bucketHint: row.bucket_hint || null,
    };
  }

  close(): void {
    this.#database.close();
  }
}
