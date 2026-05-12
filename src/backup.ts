// Orchestrates a single backup or restore: db.ts state + pg.ts dump + s3.ts upload.
// Centralizes file naming, retention math, and per-run telemetry.

import { PassThrough } from "node:stream";
import { mkdirSync, createReadStream, createWriteStream, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { databases, destinations, schedules, backups } from "./db.ts";
import type { Database_, Destination, Schedule } from "./db.ts";
import { streamDump, streamRestore } from "./pg.ts";
import {
  uploadStream,
  listObjects,
  deleteObject,
  getObjectStream,
} from "./s3.ts";

const SCRATCH = process.env.SCRATCH_DIR ?? "/scratch";
mkdirSync(SCRATCH, { recursive: true });

const RETENTION_DAILY_DEFAULT = Number(process.env.RETENTION_DAILY ?? 7);
const RETENTION_WEEKLY_DEFAULT = Number(process.env.RETENTION_WEEKLY ?? 4);
const RETENTION_MONTHLY_DEFAULT = Number(process.env.RETENTION_MONTHLY ?? 6);

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupFileName(db: Database_): string {
  return `${db.name}-${timestamp()}.dump`;
}

function s3KeyFor(db: Database_, filename: string): string {
  return `${db.name}/${filename}`;
}

/**
 * Run a single backup end-to-end: pg_dump -> local scratch -> upload S3 -> remove scratch.
 * The scratch step gives us a sha256 and size before upload, and allows resuming if upload fails.
 */
export async function runBackup(opts: {
  database_id: number;
  destination_id: number;
  schedule_id?: number | null;
}): Promise<{ backup_id: number; ok: boolean; error?: string }> {
  const db = databases.get(opts.database_id);
  const dest = destinations.get(opts.destination_id);
  if (!db) return { backup_id: -1, ok: false, error: "database not found" };
  if (!dest) return { backup_id: -1, ok: false, error: "destination not found" };

  const filename = backupFileName(db);
  const scratchPath = join(SCRATCH, filename);
  const startMs = Date.now();

  const record = backups.create({
    database_id: db.id,
    destination_id: dest.id,
    schedule_id: opts.schedule_id ?? null,
    filename,
  });

  // 1. pg_dump -> scratch file
  const out = createWriteStream(scratchPath);
  const dumpRes = await streamDump(db, out);
  await new Promise<void>((res) => out.on("close", () => res()));

  if (!dumpRes.ok) {
    backups.finish(record.id, {
      status: "failed",
      duration_ms: Date.now() - startMs,
      error: dumpRes.error ?? "pg_dump failed",
    });
    try {
      unlinkSync(scratchPath);
    } catch {}
    return { backup_id: record.id, ok: false, error: dumpRes.error };
  }

  // 2. Upload to S3
  const key = s3KeyFor(db, filename);
  let s3Key: string | null = null;
  try {
    const body = createReadStream(scratchPath);
    await uploadStream(dest, key, body);
    s3Key = (dest.path_prefix ?? "") + key;
  } catch (e: any) {
    backups.finish(record.id, {
      status: "failed",
      duration_ms: Date.now() - startMs,
      size_bytes: statSync(scratchPath).size,
      checksum_sha256: dumpRes.sha256,
      error: `upload failed: ${e.message}`,
    });
    try {
      unlinkSync(scratchPath);
    } catch {}
    return { backup_id: record.id, ok: false, error: e.message };
  }

  // 3. Cleanup scratch
  let size = 0;
  try {
    size = statSync(scratchPath).size;
    unlinkSync(scratchPath);
  } catch {}

  backups.finish(record.id, {
    status: "success",
    size_bytes: size,
    s3_key: s3Key,
    checksum_sha256: dumpRes.sha256,
    duration_ms: Date.now() - startMs,
  });

  // 4. Apply retention to this site's prefix
  if (opts.schedule_id) {
    const sched = schedules.get(opts.schedule_id);
    if (sched) {
      await applyRetention(db, dest, sched).catch((e) =>
        console.warn("[retention]", e),
      );
    }
  }

  return { backup_id: record.id, ok: true };
}

/**
 * Restore from an S3 object key into the target database. Streams S3 download
 * straight into pg_restore stdin; no scratch file needed.
 */
export async function runRestore(opts: {
  database_id: number;
  destination_id: number;
  s3_key: string;
  cleanFirst?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const db = databases.get(opts.database_id);
  const dest = destinations.get(opts.destination_id);
  if (!db) return { ok: false, error: "database not found" };
  if (!dest) return { ok: false, error: "destination not found" };

  // Strip path_prefix if user passed full key
  const keyRelative = opts.s3_key.startsWith(dest.path_prefix ?? "")
    ? opts.s3_key.slice((dest.path_prefix ?? "").length)
    : opts.s3_key;

  const { body } = await getObjectStream(dest, keyRelative);
  return await streamRestore(db, body, opts.cleanFirst ?? false);
}

/**
 * Retention: keep N daily + N weekly + N monthly. Simple bucket-by-day algorithm.
 * For each backup older than the retention window, delete from S3.
 */
async function applyRetention(
  db: Database_,
  dest: Destination,
  sched: Schedule,
): Promise<void> {
  const objects = await listObjects(dest, `${db.name}/`);
  // Backups are filenames like <name>-2026-05-12T03-00-00-000Z.dump
  // Already sorted newest first by listObjects.

  const daily = sched.retention_daily ?? RETENTION_DAILY_DEFAULT;
  const weekly = sched.retention_weekly ?? RETENTION_WEEKLY_DEFAULT;
  const monthly = sched.retention_monthly ?? RETENTION_MONTHLY_DEFAULT;

  const now = new Date();
  const keepDaily: string[] = [];
  const keepWeekly: Map<string, string> = new Map();
  const keepMonthly: Map<string, string> = new Map();

  for (const obj of objects) {
    const age = (now.getTime() - obj.lastModified.getTime()) / (1000 * 60 * 60 * 24);
    if (age < daily) {
      keepDaily.push(obj.key);
      continue;
    }
    // Weekly bucket: year-week
    const y = obj.lastModified.getUTCFullYear();
    const w = isoWeek(obj.lastModified);
    const wKey = `${y}-W${w}`;
    if (!keepWeekly.has(wKey) && keepWeekly.size < weekly) {
      keepWeekly.set(wKey, obj.key);
      continue;
    }
    // Monthly bucket
    const mKey = `${y}-${String(obj.lastModified.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!keepMonthly.has(mKey) && keepMonthly.size < monthly) {
      keepMonthly.set(mKey, obj.key);
      continue;
    }
  }

  const keep = new Set<string>([
    ...keepDaily,
    ...keepWeekly.values(),
    ...keepMonthly.values(),
  ]);

  for (const obj of objects) {
    if (keep.has(obj.key)) continue;
    const keyRelative = obj.key.startsWith(dest.path_prefix ?? "")
      ? obj.key.slice((dest.path_prefix ?? "").length)
      : obj.key;
    try {
      await deleteObject(dest, keyRelative);
      console.log(`[retention] deleted ${obj.key}`);
    } catch (e: any) {
      console.warn(`[retention] failed to delete ${obj.key}: ${e.message}`);
    }
  }
}

function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
