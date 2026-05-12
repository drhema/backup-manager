// Lightweight cron scheduler. Ticks once per SCHEDULER_TICK_SECONDS, evaluates
// each enabled schedule, runs any that are due.
//
// Supports standard 5-field cron syntax: "m h dom mon dow" (UTC).
// Special values: numeric, *, comma lists, ranges (no slash-step).

import { schedules } from "./db.ts";
import { runBackup } from "./backup.ts";

const TICK_SECONDS = Number(process.env.SCHEDULER_TICK_SECONDS ?? 60);

let running = false;
const inflight = new Set<number>();

export function startScheduler() {
  if (running) return;
  running = true;
  setInterval(tick, TICK_SECONDS * 1000);
  // Run once immediately to catch any schedules due at startup
  setTimeout(tick, 5_000);
  console.log(`[scheduler] started (tick every ${TICK_SECONDS}s)`);
}

async function tick() {
  const now = new Date();
  const all = schedules.enabled();
  for (const s of all) {
    if (!isDue(s.cron, now, s.last_run_at)) continue;
    if (inflight.has(s.id)) continue;
    inflight.add(s.id);
    runScheduled(s.id, s.database_id, s.destination_id).finally(() =>
      inflight.delete(s.id),
    );
  }
}

async function runScheduled(
  schedule_id: number,
  database_id: number,
  destination_id: number,
) {
  console.log(`[scheduler] running schedule ${schedule_id}`);
  const res = await runBackup({ database_id, destination_id, schedule_id });
  if (res.ok) {
    schedules.setLastRun(schedule_id, new Date().toISOString());
    console.log(`[scheduler] schedule ${schedule_id} -> backup ${res.backup_id} OK`);
  } else {
    console.warn(
      `[scheduler] schedule ${schedule_id} FAILED: ${res.error ?? "unknown error"}`,
    );
  }
}

/** Cron matcher: does cron expression match a given Date (UTC)? */
function isDue(cron: string, now: Date, lastRunAt: string | null): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    console.warn(`[scheduler] invalid cron "${cron}"; expected 5 fields`);
    return false;
  }
  const [m, h, dom, mon, dow] = parts;
  const match =
    matchField(m, now.getUTCMinutes(), 0, 59) &&
    matchField(h, now.getUTCHours(), 0, 23) &&
    matchField(dom, now.getUTCDate(), 1, 31) &&
    matchField(mon, now.getUTCMonth() + 1, 1, 12) &&
    matchField(dow, now.getUTCDay(), 0, 6);
  if (!match) return false;

  // Avoid double-firing within the same minute by remembering last_run_at.
  if (lastRunAt) {
    const last = new Date(lastRunAt);
    if (
      last.getUTCFullYear() === now.getUTCFullYear() &&
      last.getUTCMonth() === now.getUTCMonth() &&
      last.getUTCDate() === now.getUTCDate() &&
      last.getUTCHours() === now.getUTCHours() &&
      last.getUTCMinutes() === now.getUTCMinutes()
    ) {
      return false;
    }
  }
  return true;
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field === "*") return true;
  for (const piece of field.split(",")) {
    // Step values: */N, A/N, A-B/N
    let body = piece;
    let step = 1;
    if (piece.includes("/")) {
      const [b, s] = piece.split("/");
      body = b;
      step = Number(s);
      if (!Number.isFinite(step) || step < 1) continue;
    }
    let lo = min;
    let hi = max;
    if (body === "*") {
      // already lo=min, hi=max
    } else if (body.includes("-")) {
      const [a, b] = body.split("-").map(Number);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      lo = a;
      hi = b;
    } else {
      const n = Number(body);
      if (!Number.isFinite(n)) continue;
      lo = n;
      hi = step === 1 ? n : max;
    }
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
  }
  return false;
}
