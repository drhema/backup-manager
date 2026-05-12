// SQLite storage layer using Bun's built-in driver.
// Schema: databases, destinations, schedules, backups.
// Sensitive columns are encrypted via crypto.ts.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { encrypt, decrypt } from "./crypto.ts";

const DATA_DIR = process.env.DATA_DIR ?? "/data";
mkdirSync(DATA_DIR, { recursive: true });

const dbFile = join(DATA_DIR, "config.sqlite");
const db = new Database(dbFile, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// ---- Schema ----
db.exec(`
CREATE TABLE IF NOT EXISTS databases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  container_name  TEXT NOT NULL,
  pg_user         TEXT NOT NULL,
  pg_password_enc TEXT NOT NULL,
  pg_database     TEXT NOT NULL,
  pg_port         INTEGER NOT NULL DEFAULT 5432,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS destinations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL CHECK (type IN ('s3', 'b2')),
  endpoint        TEXT NOT NULL,
  region          TEXT NOT NULL DEFAULT 'auto',
  bucket          TEXT NOT NULL,
  path_prefix     TEXT NOT NULL DEFAULT '',
  access_key_enc  TEXT NOT NULL,
  secret_key_enc  TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id       INTEGER NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  destination_id    INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  cron              TEXT NOT NULL,
  retention_daily   INTEGER NOT NULL DEFAULT 7,
  retention_weekly  INTEGER NOT NULL DEFAULT 4,
  retention_monthly INTEGER NOT NULL DEFAULT 6,
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_run_at       TEXT,
  next_run_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS backups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id     INTEGER REFERENCES databases(id) ON DELETE SET NULL,
  destination_id  INTEGER REFERENCES destinations(id) ON DELETE SET NULL,
  schedule_id     INTEGER REFERENCES schedules(id) ON DELETE SET NULL,
  filename        TEXT NOT NULL,
  s3_key          TEXT,
  size_bytes      INTEGER,
  checksum_sha256 TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running','success','failed')),
  error           TEXT,
  duration_ms     INTEGER,
  started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_backups_db ON backups(database_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_backups_status ON backups(status);

CREATE TABLE IF NOT EXISTS provisioned_postgres (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE,
  subdomain       TEXT NOT NULL UNIQUE,
  domain          TEXT NOT NULL,
  host_port       INTEGER NOT NULL,
  pg_version      TEXT NOT NULL,
  cf_record_id    TEXT,
  portainer_stack_id INTEGER,
  container_name  TEXT NOT NULL,
  database_id     INTEGER REFERENCES databases(id) ON DELETE SET NULL,
  status          TEXT NOT NULL CHECK (status IN ('creating','ready','failed','deleted')),
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);

// ---- Types ----
export type Database_ = {
  id: number;
  name: string;
  container_name: string;
  pg_user: string;
  pg_password: string;
  pg_database: string;
  pg_port: number;
  created_at: string;
};

export type Destination = {
  id: number;
  name: string;
  type: "s3" | "b2";
  endpoint: string;
  region: string;
  bucket: string;
  path_prefix: string;
  access_key: string;
  secret_key: string;
  created_at: string;
};

export type Schedule = {
  id: number;
  database_id: number;
  destination_id: number;
  cron: string;
  retention_daily: number;
  retention_weekly: number;
  retention_monthly: number;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
};

export type Backup = {
  id: number;
  database_id: number | null;
  destination_id: number | null;
  schedule_id: number | null;
  filename: string;
  s3_key: string | null;
  size_bytes: number | null;
  checksum_sha256: string | null;
  status: "running" | "success" | "failed";
  error: string | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
};

// ---- Databases ----
export const databases = {
  list(): Database_[] {
    const rows = db
      .query("SELECT * FROM databases ORDER BY name")
      .all() as any[];
    return rows.map((r) => ({ ...r, pg_password: decrypt(r.pg_password_enc) }));
  },
  get(id: number): Database_ | null {
    const r = db
      .query("SELECT * FROM databases WHERE id = ?")
      .get(id) as any;
    if (!r) return null;
    return { ...r, pg_password: decrypt(r.pg_password_enc) };
  },
  create(
    input: Omit<Database_, "id" | "created_at" | "pg_port"> & {
      pg_port?: number;
    },
  ): Database_ {
    const pg_port = input.pg_port ?? 5432;
    const info = db
      .query(
        `INSERT INTO databases (name, container_name, pg_user, pg_password_enc, pg_database, pg_port)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.container_name,
        input.pg_user,
        encrypt(input.pg_password),
        input.pg_database,
        pg_port,
      );
    return this.get(Number(info.lastInsertRowid))!;
  },
  update(id: number, input: Partial<Omit<Database_, "id" | "created_at">>) {
    const cur = this.get(id);
    if (!cur) throw new Error("Database not found");
    const merged = { ...cur, ...input };
    db.query(
      `UPDATE databases SET name=?, container_name=?, pg_user=?, pg_password_enc=?, pg_database=?, pg_port=? WHERE id=?`,
    ).run(
      merged.name,
      merged.container_name,
      merged.pg_user,
      encrypt(merged.pg_password),
      merged.pg_database,
      merged.pg_port,
      id,
    );
    return this.get(id)!;
  },
  remove(id: number) {
    db.query("DELETE FROM databases WHERE id = ?").run(id);
  },
};

// ---- Destinations ----
export const destinations = {
  list(): Destination[] {
    const rows = db
      .query("SELECT * FROM destinations ORDER BY name")
      .all() as any[];
    return rows.map((r) => ({
      ...r,
      access_key: decrypt(r.access_key_enc),
      secret_key: decrypt(r.secret_key_enc),
    }));
  },
  get(id: number): Destination | null {
    const r = db
      .query("SELECT * FROM destinations WHERE id = ?")
      .get(id) as any;
    if (!r) return null;
    return {
      ...r,
      access_key: decrypt(r.access_key_enc),
      secret_key: decrypt(r.secret_key_enc),
    };
  },
  create(
    input: Omit<Destination, "id" | "created_at">,
  ): Destination {
    const info = db
      .query(
        `INSERT INTO destinations (name, type, endpoint, region, bucket, path_prefix, access_key_enc, secret_key_enc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.type,
        input.endpoint,
        input.region,
        input.bucket,
        input.path_prefix,
        encrypt(input.access_key),
        encrypt(input.secret_key),
      );
    return this.get(Number(info.lastInsertRowid))!;
  },
  remove(id: number) {
    db.query("DELETE FROM destinations WHERE id = ?").run(id);
  },
};

// ---- Schedules ----
export const schedules = {
  list(): Schedule[] {
    return db
      .query("SELECT * FROM schedules ORDER BY id")
      .all() as Schedule[];
  },
  enabled(): Schedule[] {
    return db
      .query("SELECT * FROM schedules WHERE enabled = 1")
      .all() as Schedule[];
  },
  get(id: number): Schedule | null {
    return (
      (db.query("SELECT * FROM schedules WHERE id = ?").get(id) as Schedule) ??
      null
    );
  },
  create(input: Omit<Schedule, "id" | "created_at" | "last_run_at" | "next_run_at">): Schedule {
    const info = db
      .query(
        `INSERT INTO schedules (database_id, destination_id, cron, retention_daily, retention_weekly, retention_monthly, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.database_id,
        input.destination_id,
        input.cron,
        input.retention_daily,
        input.retention_weekly,
        input.retention_monthly,
        input.enabled,
      );
    return this.get(Number(info.lastInsertRowid))!;
  },
  setEnabled(id: number, enabled: boolean) {
    db.query("UPDATE schedules SET enabled=? WHERE id=?").run(
      enabled ? 1 : 0,
      id,
    );
  },
  setLastRun(id: number, when: string) {
    db.query("UPDATE schedules SET last_run_at=? WHERE id=?").run(when, id);
  },
  remove(id: number) {
    db.query("DELETE FROM schedules WHERE id = ?").run(id);
  },
};

// ---- Backups ----
export const backups = {
  list(limit = 100): Backup[] {
    return db
      .query("SELECT * FROM backups ORDER BY started_at DESC LIMIT ?")
      .all(limit) as Backup[];
  },
  listForDatabase(database_id: number, limit = 50): Backup[] {
    return db
      .query(
        "SELECT * FROM backups WHERE database_id = ? ORDER BY started_at DESC LIMIT ?",
      )
      .all(database_id, limit) as Backup[];
  },
  get(id: number): Backup | null {
    return (db.query("SELECT * FROM backups WHERE id = ?").get(id) as Backup) ?? null;
  },
  create(input: {
    database_id: number;
    destination_id: number | null;
    schedule_id: number | null;
    filename: string;
  }): Backup {
    const info = db
      .query(
        `INSERT INTO backups (database_id, destination_id, schedule_id, filename, status)
         VALUES (?, ?, ?, ?, 'running')`,
      )
      .run(
        input.database_id,
        input.destination_id,
        input.schedule_id,
        input.filename,
      );
    return this.get(Number(info.lastInsertRowid))!;
  },
  finish(
    id: number,
    fields: {
      status: "success" | "failed";
      size_bytes?: number;
      s3_key?: string;
      checksum_sha256?: string;
      error?: string;
      duration_ms: number;
    },
  ) {
    db.query(
      `UPDATE backups SET status=?, size_bytes=?, s3_key=?, checksum_sha256=?, error=?, duration_ms=?, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`,
    ).run(
      fields.status,
      fields.size_bytes ?? null,
      fields.s3_key ?? null,
      fields.checksum_sha256 ?? null,
      fields.error ?? null,
      fields.duration_ms,
      id,
    );
  },
  remove(id: number) {
    db.query("DELETE FROM backups WHERE id = ?").run(id);
  },
};

// ---- Provisioned Postgres ----
export type ProvisionedPostgres = {
  id: number;
  slug: string;
  subdomain: string;
  domain: string;
  host_port: number;
  pg_version: string;
  cf_record_id: string | null;
  portainer_stack_id: number | null;
  container_name: string;
  database_id: number | null;
  status: "creating" | "ready" | "failed" | "deleted";
  error: string | null;
  created_at: string;
};

export const provisioned = {
  list(): ProvisionedPostgres[] {
    return db
      .query("SELECT * FROM provisioned_postgres WHERE status != 'deleted' ORDER BY id DESC")
      .all() as ProvisionedPostgres[];
  },
  get(id: number): ProvisionedPostgres | null {
    return (db
      .query("SELECT * FROM provisioned_postgres WHERE id = ?")
      .get(id) as ProvisionedPostgres) ?? null;
  },
  create(input: {
    slug: string;
    subdomain: string;
    domain: string;
    host_port: number;
    pg_version: string;
    container_name: string;
  }): ProvisionedPostgres {
    const info = db
      .query(
        `INSERT INTO provisioned_postgres (slug, subdomain, domain, host_port, pg_version, container_name, status)
         VALUES (?, ?, ?, ?, ?, ?, 'creating')`,
      )
      .run(
        input.slug,
        input.subdomain,
        input.domain,
        input.host_port,
        input.pg_version,
        input.container_name,
      );
    return this.get(Number(info.lastInsertRowid))!;
  },
  update(id: number, fields: Partial<Omit<ProvisionedPostgres, "id" | "created_at">>) {
    const cur = this.get(id);
    if (!cur) throw new Error("Provisioned record not found");
    const merged = { ...cur, ...fields };
    db.query(
      `UPDATE provisioned_postgres SET slug=?, subdomain=?, domain=?, host_port=?, pg_version=?,
         cf_record_id=?, portainer_stack_id=?, container_name=?, database_id=?, status=?, error=?
       WHERE id=?`,
    ).run(
      merged.slug,
      merged.subdomain,
      merged.domain,
      merged.host_port,
      merged.pg_version,
      merged.cf_record_id,
      merged.portainer_stack_id,
      merged.container_name,
      merged.database_id,
      merged.status,
      merged.error,
      id,
    );
  },
};

// ---- First-run seed from env (optional default destination) ----
export function seedDefaults() {
  const want =
    process.env.DEFAULT_S3_NAME &&
    process.env.DEFAULT_S3_BUCKET &&
    process.env.DEFAULT_S3_ACCESS_KEY &&
    process.env.DEFAULT_S3_SECRET_KEY;
  if (!want) return;

  const existing = destinations
    .list()
    .find((d) => d.name === process.env.DEFAULT_S3_NAME);
  if (existing) return;

  destinations.create({
    name: process.env.DEFAULT_S3_NAME!,
    type: (process.env.DEFAULT_S3_TYPE ?? "s3") as "s3" | "b2",
    endpoint: process.env.DEFAULT_S3_ENDPOINT ?? "",
    region: process.env.DEFAULT_S3_REGION ?? "auto",
    bucket: process.env.DEFAULT_S3_BUCKET!,
    path_prefix: process.env.DEFAULT_S3_PATH_PREFIX ?? "postgres/",
    access_key: process.env.DEFAULT_S3_ACCESS_KEY!,
    secret_key: process.env.DEFAULT_S3_SECRET_KEY!,
  });
  console.log(
    `[seed] Created default destination '${process.env.DEFAULT_S3_NAME}' from env.`,
  );
}
