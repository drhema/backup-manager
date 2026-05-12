import type { FC } from "hono/jsx";
import { Layout, Card, Btn, Badge, formatTime } from "./layout.tsx";
import type { Schedule, Database_, Destination } from "../db.ts";

export const Schedules: FC<{
  items: Schedule[];
  databases: Database_[];
  destinations: Destination[];
  showForm?: boolean;
}> = ({ items, databases, destinations, showForm = false }) => (
  <Layout title="Schedules" active="schedules">
    <div class="space-y-6">
      <header class="flex items-end justify-between">
        <h1 class="text-2xl font-bold">Schedules</h1>
        {!showForm && <Btn href="/schedules?action=new" variant="primary">+ Add schedule</Btn>}
      </header>

      {showForm && <NewScheduleForm databases={databases} destinations={destinations} />}

      <Card title="Active schedules">
        {items.length === 0 ? (
          <p class="text-sm text-slate-500">No schedules yet.</p>
        ) : (
          <table class="w-full text-sm">
            <thead class="text-left text-slate-500 border-b">
              <tr>
                <th class="py-2">Database</th>
                <th>Destination</th>
                <th>Cron (UTC)</th>
                <th>Retention (d/w/m)</th>
                <th>Enabled</th>
                <th>Last run</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => {
                const db = databases.find((d) => d.id === s.database_id);
                const dest = destinations.find((d) => d.id === s.destination_id);
                return (
                  <tr class="border-b last:border-0">
                    <td class="py-2 font-mono">{db?.name ?? "—"}</td>
                    <td class="font-mono text-xs">{dest?.name ?? "—"}</td>
                    <td class="font-mono">{s.cron}</td>
                    <td>{s.retention_daily}/{s.retention_weekly}/{s.retention_monthly}</td>
                    <td>{s.enabled ? <Badge tone="success">on</Badge> : <Badge tone="neutral">off</Badge>}</td>
                    <td class="text-slate-500 text-xs">{formatTime(s.last_run_at)}</td>
                    <td class="text-right">
                      <form method="post" action={`/schedules/${s.id}/toggle`} class="inline">
                        <Btn type="submit">{s.enabled ? "disable" : "enable"}</Btn>
                      </form>
                      <form method="post" action={`/schedules/${s.id}/delete`} class="inline" onsubmit="return confirm('Delete schedule?')">
                        <Btn type="submit" variant="danger">delete</Btn>
                      </form>
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

const NewScheduleForm: FC<{ databases: Database_[]; destinations: Destination[] }> = ({
  databases,
  destinations,
}) => (
  <Card title="Add schedule">
    {databases.length === 0 || destinations.length === 0 ? (
      <p class="text-sm text-slate-500">
        You need at least one database and one destination first.
      </p>
    ) : (
      <form method="post" action="/schedules" class="space-y-3 max-w-xl">
        <label class="block">
          <span class="block text-sm font-medium text-slate-700">Database</span>
          <select name="database_id" required class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border">
            {databases.map((d) => (
              <option value={d.id}>{d.name} ({d.container_name})</option>
            ))}
          </select>
        </label>
        <label class="block">
          <span class="block text-sm font-medium text-slate-700">Destination</span>
          <select name="destination_id" required class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border">
            {destinations.map((d) => (
              <option value={d.id}>{d.name} ({d.bucket})</option>
            ))}
          </select>
        </label>
        <label class="block">
          <span class="block text-sm font-medium text-slate-700">Cron (5 fields, UTC)</span>
          <input name="cron" required placeholder="0 3 * * *" value="0 3 * * *"
                 class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border font-mono" />
          <span class="block text-xs text-slate-500 mt-1">Examples: <code>0 3 * * *</code> daily at 03:00 · <code>*/15 * * * *</code> every 15 min · <code>0 4 * * 0</code> weekly Sunday 04:00</span>
        </label>
        <div class="grid grid-cols-3 gap-2">
          <NumField label="Retain daily" name="retention_daily" defaultValue={7} />
          <NumField label="Retain weekly" name="retention_weekly" defaultValue={4} />
          <NumField label="Retain monthly" name="retention_monthly" defaultValue={6} />
        </div>
        <div class="flex gap-2 pt-2">
          <Btn type="submit" variant="primary">Create</Btn>
          <Btn href="/schedules">Cancel</Btn>
        </div>
      </form>
    )}
  </Card>
);

const NumField: FC<{ label: string; name: string; defaultValue: number }> = ({
  label,
  name,
  defaultValue,
}) => (
  <label class="block">
    <span class="block text-xs text-slate-700">{label}</span>
    <input
      type="number"
      name={name}
      value={String(defaultValue)}
      min="0"
      class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border"
    />
  </label>
);
