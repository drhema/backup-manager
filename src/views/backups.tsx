import type { FC } from "hono/jsx";
import { Layout, Card, Btn, Badge, formatBytes, formatDuration, formatTime } from "./layout.tsx";
import type { Backup, Database_, Destination } from "../db.ts";

export const Backups: FC<{
  items: Backup[];
  databases: Database_[];
  destinations: Destination[];
}> = ({ items, databases, destinations }) => (
  <Layout title="Backups" active="backups">
    <div class="space-y-6">
      <header class="flex items-end justify-between">
        <h1 class="text-2xl font-bold">Backups</h1>
        <p class="text-sm text-slate-500">Most recent first. Click a row for details + restore.</p>
      </header>

      <Card>
        {items.length === 0 ? (
          <p class="text-sm text-slate-500">No backups recorded yet.</p>
        ) : (
          <table class="w-full text-sm">
            <thead class="text-left text-slate-500 border-b">
              <tr>
                <th class="py-2">Database</th>
                <th>Destination</th>
                <th>Status</th>
                <th>Size</th>
                <th>Duration</th>
                <th>Started</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => {
                const db = databases.find((d) => d.id === b.database_id);
                const dest = destinations.find((d) => d.id === b.destination_id);
                return (
                  <tr class="border-b last:border-0 hover:bg-slate-50">
                    <td class="py-2 font-mono">{db?.name ?? "(deleted)"}</td>
                    <td class="font-mono text-xs">{dest?.name ?? "(deleted)"}</td>
                    <td>
                      {b.status === "success" ? <Badge tone="success">success</Badge> :
                       b.status === "failed" ? <Badge tone="danger">failed</Badge> :
                       <Badge tone="info">running</Badge>}
                    </td>
                    <td>{formatBytes(b.size_bytes)}</td>
                    <td>{formatDuration(b.duration_ms)}</td>
                    <td class="text-slate-500">{formatTime(b.started_at)}</td>
                    <td class="text-right">
                      {b.status === "success" && b.s3_key && (
                        <>
                          <Btn href={`/backups/${b.id}/download`}>download</Btn>
                          <Btn href={`/backups/${b.id}/restore`} variant="secondary">restore</Btn>
                        </>
                      )}
                      {b.status === "failed" && (
                        <Btn href={`/backups/${b.id}`}>error</Btn>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  </Layout>
);

export const RestoreForm: FC<{
  backup: Backup;
  database: Database_;
  destination: Destination;
}> = ({ backup, database, destination }) => (
  <Layout title="Restore backup" active="backups">
    <div class="space-y-6 max-w-2xl">
      <header>
        <h1 class="text-2xl font-bold">Restore backup #{backup.id}</h1>
        <p class="text-sm text-slate-500">Streams from S3 directly into pg_restore. Make sure the target database is what you intend.</p>
      </header>

      <Card title="Source">
        <dl class="text-sm">
          <Row k="Database (origin)" v={database.name} />
          <Row k="Destination" v={destination.name} />
          <Row k="S3 key" v={backup.s3_key ?? "—"} />
          <Row k="Size" v={formatBytes(backup.size_bytes)} />
          <Row k="Created" v={formatTime(backup.started_at)} />
        </dl>
      </Card>

      <form method="post" action={`/backups/${backup.id}/restore`}>
        <Card title="Restore options">
          <div class="space-y-3 text-sm">
            <p>Target database: <span class="font-mono">{database.name}</span> (container <span class="font-mono">{database.container_name}</span>)</p>
            <label class="flex items-start gap-2">
              <input type="checkbox" name="clean" value="1" class="mt-1" />
              <span>
                <strong class="text-red-700">Destructive:</strong> add <code>--clean --if-exists</code> — drops existing
                objects in the target DB before restoring. Use only when restoring over a populated DB.
              </span>
            </label>
            <label class="flex items-start gap-2 mt-3">
              <input type="checkbox" name="confirm" value="1" required />
              <span>I understand this will modify <span class="font-mono">{database.pg_database}</span>.</span>
            </label>
          </div>
        </Card>
        <div class="flex gap-2 mt-4">
          <Btn type="submit" variant="primary">Start restore</Btn>
          <Btn href={`/backups`}>Cancel</Btn>
        </div>
      </form>
    </div>
  </Layout>
);

const Row: FC<{ k: string; v: string }> = ({ k, v }) => (
  <div class="flex border-b last:border-0 py-1.5">
    <dt class="w-1/3 text-slate-500">{k}</dt>
    <dd class="font-mono">{v}</dd>
  </div>
);

export const BackupDetail: FC<{
  backup: Backup;
  database: Database_ | null;
  destination: Destination | null;
}> = ({ backup, database, destination }) => (
  <Layout title={`Backup #${backup.id}`} active="backups">
    <div class="space-y-6 max-w-3xl">
      <header>
        <h1 class="text-2xl font-bold">Backup #{backup.id}</h1>
        <p class="text-sm text-slate-500">{formatTime(backup.started_at)}</p>
      </header>

      <Card>
        <dl class="text-sm">
          <Row k="Database" v={database?.name ?? "(deleted)"} />
          <Row k="Destination" v={destination?.name ?? "(deleted)"} />
          <Row k="Status" v={backup.status} />
          <Row k="Filename" v={backup.filename} />
          <Row k="S3 key" v={backup.s3_key ?? "—"} />
          <Row k="Size" v={formatBytes(backup.size_bytes)} />
          <Row k="Duration" v={formatDuration(backup.duration_ms)} />
          <Row k="Checksum (sha256)" v={backup.checksum_sha256 ?? "—"} />
          <Row k="Started" v={formatTime(backup.started_at)} />
          <Row k="Finished" v={formatTime(backup.finished_at)} />
        </dl>
        {backup.error && (
          <div class="mt-4">
            <h3 class="text-sm font-semibold text-red-700">Error</h3>
            <pre class="text-xs bg-red-50 border border-red-200 rounded p-3 mt-1 whitespace-pre-wrap">{backup.error}</pre>
          </div>
        )}
      </Card>
    </div>
  </Layout>
);
