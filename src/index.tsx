// Backup Manager — main entry: Hono routes + scheduler boot.

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { databases, destinations, schedules, backups, provisioned, provisionedRedis, seedDefaults } from "./db.ts";
import { runBackup, runRestore } from "./backup.ts";
import {
  pingDatabase,
} from "./pg.ts";
import {
  listObjects,
  testDestination,
  deleteObject,
  signedDownloadUrl,
} from "./s3.ts";
import { startScheduler } from "./scheduler.ts";
import { cfAccessMiddleware } from "./auth.ts";
import { provisionPostgres, deprovisionPostgres } from "./provision.ts";
import { cfConfigured } from "./cloudflare.ts";
import { portainerConfigured } from "./portainer.ts";
import { Layout } from "./views/layout.tsx";
import { Dashboard } from "./views/dashboard.tsx";
import { Databases, DatabaseDetail } from "./views/databases.tsx";
import { Destinations } from "./views/destinations.tsx";
import { Backups, BackupDetail, RestoreForm } from "./views/backups.tsx";
import { Schedules } from "./views/schedules.tsx";
import { S3Browser } from "./views/s3browser.tsx";
import { ProvisionList, ProvisionForm, ProvisionResult, ProvisionDetail } from "./views/provision.tsx";
import { ProvisionRedisList, ProvisionRedisForm, ProvisionRedisResult, ProvisionRedisDetail } from "./views/provision-redis.tsx";
import { provisionRedis, deprovisionRedis } from "./provision-redis.ts";

const app = new Hono();

// CF Access JWT verification (no-op if not configured)
app.use("*", cfAccessMiddleware);

// ----- Health (always public, no auth) -----
app.get("/healthz", (c) => c.text("ok"));

// ----- Dashboard -----
app.get("/", (c) => {
  const dbs = databases.list();
  const dests = destinations.list();
  const scheds = schedules.list();
  const recent = backups.list(50);
  return c.html(<Dashboard databases={dbs} destinations={dests} schedules={scheds} recentBackups={recent} />);
});

// ===== Databases =====
app.get("/databases", (c) => {
  const showForm = c.req.query("action") === "new";
  return c.html(<Databases items={databases.list()} showForm={showForm} />);
});

app.post("/databases", async (c) => {
  const form = await c.req.parseBody();
  databases.create({
    name: String(form.name),
    container_name: String(form.container_name),
    pg_user: String(form.pg_user),
    pg_password: String(form.pg_password),
    pg_database: String(form.pg_database),
    pg_port: form.pg_port ? Number(form.pg_port) : undefined,
  });
  return c.redirect("/databases");
});

app.get("/databases/:id", (c) => {
  const id = Number(c.req.param("id"));
  const db = databases.get(id);
  if (!db) return c.notFound();
  return c.html(<DatabaseDetail db={db} backups={backups.listForDatabase(id, 50)} />);
});

app.post("/databases/:id/delete", (c) => {
  databases.remove(Number(c.req.param("id")));
  return c.redirect("/databases");
});

app.post("/databases/:id/ping", async (c) => {
  const db = databases.get(Number(c.req.param("id")));
  if (!db) return c.html('<span class="text-red-700">not found</span>');
  const result = await pingDatabase(db);
  if (result.ok) {
    return c.html('<span class="text-emerald-700">✓ reachable</span>');
  }
  return c.html(`<span class="text-red-700">✗ ${escape(result.error ?? "failed")}</span>`);
});

app.get("/databases/:id/backup-now", async (c) => {
  // Quick-pick destination: first one in DB (most installations only have 1).
  const id = Number(c.req.param("id"));
  const dests = destinations.list();
  if (dests.length === 0) {
    return c.text("Configure a destination first.", 400);
  }
  if (dests.length === 1) {
    // Auto-run, redirect to backups list.
    runBackup({ database_id: id, destination_id: dests[0]!.id }).catch((e) =>
      console.error("[backup-now] failed:", e),
    );
    return c.redirect("/backups");
  }
  // Multiple destinations: render a picker
  return c.html(
    <Layout title="Backup now" active="backups">
      <div class="max-w-md space-y-4">
        <h1 class="text-xl font-bold">Pick a destination</h1>
        <form method="post" action={`/databases/${id}/backup-now`}>
          <select name="destination_id" class="block w-full border rounded py-2 px-3">
            {dests.map((d) => (
              <option value={d.id}>{d.name}</option>
            ))}
          </select>
          <button type="submit" class="mt-3 bg-slate-900 text-white px-3 py-2 rounded">Start backup</button>
        </form>
      </div>
    </Layout>,
  );
});

app.post("/databases/:id/backup-now", async (c) => {
  const id = Number(c.req.param("id"));
  const form = await c.req.parseBody();
  const destination_id = Number(form.destination_id);
  runBackup({ database_id: id, destination_id }).catch((e) =>
    console.error("[backup-now] failed:", e),
  );
  return c.redirect("/backups");
});

// ===== Destinations =====
app.get("/destinations", (c) => {
  const showForm = c.req.query("action") === "new";
  return c.html(<Destinations items={destinations.list()} showForm={showForm} />);
});

app.post("/destinations", async (c) => {
  const form = await c.req.parseBody();
  destinations.create({
    name: String(form.name),
    type: (String(form.type) as "s3" | "b2") ?? "s3",
    endpoint: String(form.endpoint),
    region: String(form.region ?? "auto"),
    bucket: String(form.bucket),
    path_prefix: String(form.path_prefix ?? ""),
    access_key: String(form.access_key),
    secret_key: String(form.secret_key),
  });
  return c.redirect("/destinations");
});

app.post("/destinations/:id/delete", (c) => {
  destinations.remove(Number(c.req.param("id")));
  return c.redirect("/destinations");
});

app.post("/destinations/:id/test", async (c) => {
  const dest = destinations.get(Number(c.req.param("id")));
  if (!dest) return c.html('<span class="text-red-700">not found</span>');
  const err = await testDestination(dest);
  if (err) {
    return c.html(`<span class="text-red-700">✗ ${escape(err)}</span>`);
  }
  return c.html('<span class="text-emerald-700">✓ reachable</span>');
});

// ===== Schedules =====
app.get("/schedules", (c) => {
  const showForm = c.req.query("action") === "new";
  return c.html(
    <Schedules
      items={schedules.list()}
      databases={databases.list()}
      destinations={destinations.list()}
      showForm={showForm}
    />,
  );
});

app.post("/schedules", async (c) => {
  const form = await c.req.parseBody();
  schedules.create({
    database_id: Number(form.database_id),
    destination_id: Number(form.destination_id),
    cron: String(form.cron),
    retention_daily: Number(form.retention_daily ?? 7),
    retention_weekly: Number(form.retention_weekly ?? 4),
    retention_monthly: Number(form.retention_monthly ?? 6),
    enabled: 1,
  });
  return c.redirect("/schedules");
});

app.post("/schedules/:id/toggle", (c) => {
  const id = Number(c.req.param("id"));
  const s = schedules.get(id);
  if (s) schedules.setEnabled(id, !s.enabled);
  return c.redirect("/schedules");
});

app.post("/schedules/:id/delete", (c) => {
  schedules.remove(Number(c.req.param("id")));
  return c.redirect("/schedules");
});

// ===== Backups =====
app.get("/backups", (c) => {
  return c.html(
    <Backups
      items={backups.list(200)}
      databases={databases.list()}
      destinations={destinations.list()}
    />,
  );
});

app.get("/backups/:id", (c) => {
  const id = Number(c.req.param("id"));
  const b = backups.get(id);
  if (!b) return c.notFound();
  const db = b.database_id ? databases.get(b.database_id) : null;
  const dest = b.destination_id ? destinations.get(b.destination_id) : null;
  return c.html(<BackupDetail backup={b} database={db} destination={dest} />);
});

app.get("/backups/:id/download", async (c) => {
  const id = Number(c.req.param("id"));
  const b = backups.get(id);
  if (!b || !b.s3_key || !b.destination_id) return c.notFound();
  const dest = destinations.get(b.destination_id);
  if (!dest) return c.notFound();
  // Strip path prefix because signedDownloadUrl will re-add it
  const keyRel = b.s3_key.startsWith(dest.path_prefix)
    ? b.s3_key.slice(dest.path_prefix.length)
    : b.s3_key;
  const url = await signedDownloadUrl(dest, keyRel, 600);
  return c.redirect(url);
});

app.get("/backups/:id/restore", (c) => {
  const id = Number(c.req.param("id"));
  const b = backups.get(id);
  if (!b || !b.database_id || !b.destination_id || !b.s3_key) return c.notFound();
  const db = databases.get(b.database_id);
  const dest = destinations.get(b.destination_id);
  if (!db || !dest) return c.notFound();
  return c.html(<RestoreForm backup={b} database={db} destination={dest} />);
});

app.post("/backups/:id/restore", async (c) => {
  const id = Number(c.req.param("id"));
  const b = backups.get(id);
  if (!b || !b.database_id || !b.destination_id || !b.s3_key) return c.notFound();
  const form = await c.req.parseBody();
  if (form.confirm !== "1") return c.text("Confirmation required", 400);
  const clean = form.clean === "1";

  // Kick off async; report immediately
  runRestore({
    database_id: b.database_id,
    destination_id: b.destination_id,
    s3_key: b.s3_key,
    cleanFirst: clean,
  })
    .then((r) =>
      console.log(`[restore] backup ${id} -> ${r.ok ? "ok" : "FAILED: " + r.error}`),
    )
    .catch((e) => console.error("[restore] error:", e));

  return c.html(
    <Layout title="Restore started" active="backups">
      <div class="max-w-xl space-y-4">
        <h1 class="text-xl font-bold">Restore started</h1>
        <p class="text-sm text-slate-600">
          Restore is running in the background. Watch progress in container logs:
          <code class="block mt-2 bg-slate-100 p-2 rounded text-xs">docker logs -f backup-manager</code>
        </p>
        <a href="/backups" class="inline-block mt-2 bg-slate-900 text-white px-3 py-2 rounded text-sm">
          Back to backups
        </a>
      </div>
    </Layout>,
  );
});

// ===== S3 Browser =====
app.get("/s3-browser", async (c) => {
  const dests = destinations.list();
  const destId = c.req.query("destination_id");
  const prefix = c.req.query("prefix") ?? "";
  if (!destId) {
    return c.html(<S3Browser destinations={dests} selected={null} objects={[]} prefix={prefix} />);
  }
  const dest = destinations.get(Number(destId));
  if (!dest) return c.notFound();
  let objects: any[] = [];
  try {
    objects = await listObjects(dest, prefix);
  } catch (e: any) {
    return c.html(
      <Layout title="S3 Browser" active="s3-browser">
        <div class="space-y-3">
          <h1 class="text-2xl font-bold">S3 Browser</h1>
          <div class="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800">
            Error listing objects: {e.message}
          </div>
          <a href="/s3-browser" class="inline-block bg-slate-900 text-white px-3 py-2 rounded text-sm">Back</a>
        </div>
      </Layout>,
    );
  }
  return c.html(
    <S3Browser destinations={dests} selected={dest} objects={objects} prefix={prefix} />,
  );
});

app.get("/s3-browser/download", async (c) => {
  const destId = Number(c.req.query("destination_id"));
  const key = c.req.query("key") ?? "";
  const dest = destinations.get(destId);
  if (!dest || !key) return c.notFound();
  const keyRel = key.startsWith(dest.path_prefix) ? key.slice(dest.path_prefix.length) : key;
  const url = await signedDownloadUrl(dest, keyRel, 600);
  return c.redirect(url);
});

app.post("/s3-browser/delete", async (c) => {
  const form = await c.req.parseBody();
  const destId = Number(form.destination_id);
  const key = String(form.key);
  const dest = destinations.get(destId);
  if (!dest) return c.notFound();
  const keyRel = key.startsWith(dest.path_prefix) ? key.slice(dest.path_prefix.length) : key;
  try {
    await deleteObject(dest, keyRel);
  } catch (e: any) {
    return c.text(`delete failed: ${e.message}`, 500);
  }
  return c.redirect(`/s3-browser?destination_id=${destId}`);
});

// ===== Provision Postgres =====
app.get("/provision", (c) => {
  const items = provisioned.list();
  return c.html(
    <ProvisionList
      items={items}
      cfConfigured={cfConfigured()}
      portainerConfigured={portainerConfigured()}
      baseDomain={process.env.CF_BASE_DOMAIN ?? ""}
    />,
  );
});

app.get("/provision/new", (c) => {
  if (!cfConfigured() || !portainerConfigured()) {
    return c.redirect("/provision");
  }
  return c.html(
    <ProvisionForm
      baseDomain={process.env.CF_BASE_DOMAIN ?? ""}
      portStart={Number(process.env.PROVISION_PORT_START ?? 15432)}
      portEnd={Number(process.env.PROVISION_PORT_END ?? 15999)}
    />,
  );
});

app.post("/provision/new", async (c) => {
  const form = await c.req.parseBody();
  const result = await provisionPostgres({
    slugHint: form.slug ? String(form.slug) : undefined,
    pgVersion: (String(form.pg_version) as "16" | "17" | "18") ?? "18",
    pgUser: form.pg_user ? String(form.pg_user) : undefined,
    pgDatabase: form.pg_database ? String(form.pg_database) : undefined,
  });

  if (!result.id) {
    // Provisioning failed before even creating the tracking row; just show an error layout
    return c.html(
      <Layout title="Provisioning failed" active="provision">
        <div class="max-w-xl space-y-4">
          <h1 class="text-xl font-bold text-red-700">Provisioning failed</h1>
          <pre class="text-xs bg-red-50 border border-red-200 rounded p-3 whitespace-pre-wrap">{result.error}</pre>
          <a href="/provision" class="inline-block bg-slate-900 text-white px-3 py-2 rounded text-sm">Back</a>
        </div>
      </Layout>,
    );
  }

  const rec = provisioned.get(result.id)!;
  return c.html(
    <ProvisionResult
      record={rec}
      connectionUrl={result.connectionUrl}
      pgUser={result.pgUser}
      pgPassword={result.pgPassword}
      pgDatabase={result.pgDatabase}
      error={result.ok ? undefined : result.error}
    />,
  );
});

app.get("/provision/:id", (c) => {
  const id = Number(c.req.param("id"));
  const rec = provisioned.get(id);
  if (!rec) return c.notFound();
  return c.html(<ProvisionDetail record={rec} />);
});

app.post("/provision/:id/delete", async (c) => {
  const id = Number(c.req.param("id"));
  await deprovisionPostgres(id);
  return c.redirect("/provision");
});

// ===== Provision Redis =====
app.get("/provision/redis", (c) => {
  return c.html(
    <ProvisionRedisList
      items={provisionedRedis.list()}
      cfConfigured={cfConfigured()}
      portainerConfigured={portainerConfigured()}
      baseDomain={process.env.CF_BASE_DOMAIN ?? ""}
    />,
  );
});

app.get("/provision/redis/new", (c) => {
  if (!cfConfigured() || !portainerConfigured()) return c.redirect("/provision/redis");
  return c.html(
    <ProvisionRedisForm
      baseDomain={process.env.CF_BASE_DOMAIN ?? ""}
      portStart={Number(process.env.PROVISION_REDIS_PORT_START ?? 16379)}
      portEnd={Number(process.env.PROVISION_REDIS_PORT_END ?? 16999)}
    />,
  );
});

app.post("/provision/redis/new", async (c) => {
  const form = await c.req.parseBody();
  const result = await provisionRedis({
    slugHint: form.slug ? String(form.slug) : undefined,
    redisVersion: (String(form.redis_version) as "7.4" | "7.2") ?? "7.4",
    maxMemoryMB: form.max_memory_mb ? Number(form.max_memory_mb) : undefined,
    appendOnly: form.append_only === "1",
  });

  if (!result.id) {
    return c.html(
      <Layout title="Redis provisioning failed" active="provision-redis">
        <div class="max-w-xl space-y-4">
          <h1 class="text-xl font-bold text-red-700">Provisioning failed</h1>
          <pre class="text-xs bg-red-50 border border-red-200 rounded p-3 whitespace-pre-wrap">{result.error}</pre>
          <a href="/provision/redis" class="inline-block bg-slate-900 text-white px-3 py-2 rounded text-sm">Back</a>
        </div>
      </Layout>,
    );
  }

  const rec = provisionedRedis.get(result.id)!;
  return c.html(
    <ProvisionRedisResult
      record={rec}
      connectionUrl={result.connectionUrl}
      password={result.password}
      error={result.ok ? undefined : result.error}
    />,
  );
});

app.get("/provision/redis/:id", (c) => {
  const id = Number(c.req.param("id"));
  const rec = provisionedRedis.get(id);
  if (!rec) return c.notFound();
  return c.html(<ProvisionRedisDetail record={rec} />);
});

app.post("/provision/redis/:id/delete", async (c) => {
  const id = Number(c.req.param("id"));
  await deprovisionRedis(id);
  return c.redirect("/provision/redis");
});

// ===== Boot =====
seedDefaults();
startScheduler();

const port = Number(process.env.PORT ?? 8085);
console.log(`[backup-manager] listening on http://0.0.0.0:${port}`);

export default {
  port,
  fetch: app.fetch,
};

// Tiny HTML escape for safely rendering error strings inside hx-swap responses
function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
