import type { FC } from "hono/jsx";
import { Layout, Card, Btn, Badge, formatBytes, formatTime, formatDuration } from "./layout.tsx";
import type { Database_, Destination, Backup, Schedule } from "../db.ts";

export const Dashboard: FC<{
  databases: Database_[];
  destinations: Destination[];
  schedules: Schedule[];
  recentBackups: Backup[];
}> = ({ databases, destinations, schedules, recentBackups }) => {
  const successCount = recentBackups.filter((b) => b.status === "success").length;
  const failedCount = recentBackups.filter((b) => b.status === "failed").length;
  const runningCount = recentBackups.filter((b) => b.status === "running").length;
  return (
    <Layout title="Dashboard" active="dashboard">
      <div class="space-y-6">
        <header class="flex items-end justify-between">
          <h1 class="text-2xl font-bold text-slate-900">Overview</h1>
          <div class="flex gap-2">
            <Btn href="/databases?action=new" variant="primary">+ Database</Btn>
            <Btn href="/destinations?action=new">+ Destination</Btn>
            <Btn href="/schedules?action=new">+ Schedule</Btn>
          </div>
        </header>

        <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="Databases" value={String(databases.length)} />
          <Stat label="Destinations" value={String(destinations.length)} />
          <Stat label="Schedules" value={String(schedules.filter((s) => s.enabled).length)} />
          <Stat label="Recent success" value={String(successCount)} tone="success" />
          <Stat label="Recent failed" value={String(failedCount + runningCount)} tone={failedCount ? "danger" : "neutral"} />
        </div>

        <Card title="Recent backups (last 20)">
          {recentBackups.length === 0 ? (
            <p class="text-sm text-slate-500">No backups yet. Add a Database + Destination, then trigger a backup or create a Schedule.</p>
          ) : (
            <table class="w-full text-sm">
              <thead class="text-left text-slate-500 border-b">
                <tr>
                  <th class="py-2">Database</th>
                  <th>Status</th>
                  <th>Size</th>
                  <th>Duration</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {recentBackups.slice(0, 20).map((b) => {
                  const dbName = databases.find((d) => d.id === b.database_id)?.name ?? "(deleted)";
                  return (
                    <tr class="border-b last:border-0">
                      <td class="py-2 font-mono">{dbName}</td>
                      <td>
                        {b.status === "success" ? <Badge tone="success">success</Badge> :
                         b.status === "failed" ? <Badge tone="danger">failed</Badge> :
                         <Badge tone="info">running</Badge>}
                      </td>
                      <td>{formatBytes(b.size_bytes)}</td>
                      <td>{formatDuration(b.duration_ms)}</td>
                      <td class="text-slate-500">{formatTime(b.started_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <div class="grid md:grid-cols-2 gap-4">
          <Card title="Databases" actions={<Btn href="/databases">manage →</Btn>}>
            {databases.length === 0 ? (
              <p class="text-sm text-slate-500">No databases yet. <a class="text-sky-700 underline" href="/databases?action=new">Add one</a>.</p>
            ) : (
              <ul class="text-sm divide-y">
                {databases.map((d) => (
                  <li class="py-2 flex items-center justify-between">
                    <div>
                      <span class="font-mono font-medium">{d.name}</span>
                      <span class="text-slate-500 ml-2">→ {d.container_name}</span>
                    </div>
                    <a class="text-xs text-sky-700" href={`/databases/${d.id}`}>details</a>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Destinations" actions={<Btn href="/destinations">manage →</Btn>}>
            {destinations.length === 0 ? (
              <p class="text-sm text-slate-500">No destinations yet. <a class="text-sky-700 underline" href="/destinations?action=new">Add one</a>.</p>
            ) : (
              <ul class="text-sm divide-y">
                {destinations.map((d) => (
                  <li class="py-2 flex items-center justify-between">
                    <div>
                      <span class="font-mono font-medium">{d.name}</span>
                      <span class="text-slate-500 ml-2">{d.bucket}/{d.path_prefix}</span>
                    </div>
                    <a class="text-xs text-sky-700" href={`/destinations/${d.id}`}>details</a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </Layout>
  );
};

const Stat: FC<{ label: string; value: string; tone?: "success" | "danger" | "neutral" }> = ({
  label,
  value,
  tone = "neutral",
}) => {
  const valueCls = {
    success: "text-emerald-700",
    danger: "text-red-700",
    neutral: "text-slate-900",
  }[tone];
  return (
    <div class="bg-white border border-slate-200 rounded-lg p-3">
      <div class="text-xs text-slate-500">{label}</div>
      <div class={`text-2xl font-semibold ${valueCls}`}>{value}</div>
    </div>
  );
};
