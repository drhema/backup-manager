import type { FC } from "hono/jsx";
import { Layout, Card, Btn, Badge, formatTime } from "./layout.tsx";
import type { Database_, Backup } from "../db.ts";

export const Databases: FC<{ items: Database_[]; showForm?: boolean }> = ({
  items,
  showForm = false,
}) => (
  <Layout title="Databases" active="databases">
    <div class="space-y-6">
      <header class="flex items-end justify-between">
        <h1 class="text-2xl font-bold">Databases</h1>
        {!showForm && <Btn href="/databases?action=new" variant="primary">+ Add database</Btn>}
      </header>

      {showForm && <NewDatabaseForm />}

      <Card title="Configured databases">
        {items.length === 0 ? (
          <p class="text-sm text-slate-500">No databases yet.</p>
        ) : (
          <table class="w-full text-sm">
            <thead class="text-left text-slate-500 border-b">
              <tr>
                <th class="py-2">Name</th>
                <th>Container</th>
                <th>DB user</th>
                <th>DB name</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr class="border-b last:border-0">
                  <td class="py-2 font-mono font-semibold">{d.name}</td>
                  <td class="font-mono">{d.container_name}</td>
                  <td>{d.pg_user}</td>
                  <td>{d.pg_database}</td>
                  <td class="text-right">
                    <Btn
                      hx={{
                        "hx-post": `/databases/${d.id}/ping`,
                        "hx-target": `#ping-result-${d.id}`,
                        "hx-swap": "innerHTML",
                      }}
                    >
                      ping
                    </Btn>
                    <span id={`ping-result-${d.id}`} class="ml-2 text-xs"></span>
                    <Btn href={`/databases/${d.id}/backup-now`} variant="primary">backup now</Btn>
                    <form method="post" action={`/databases/${d.id}/delete`} class="inline" onsubmit="return confirm('Delete this database config (does NOT touch the Postgres container)?')">
                      <Btn type="submit" variant="danger">delete</Btn>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  </Layout>
);

const NewDatabaseForm: FC = () => (
  <Card title="Add database">
    <form method="post" action="/databases" class="space-y-3 max-w-xl">
      <Field label="Name (site slug)" name="name" placeholder="similarpng" required />
      <Field label="Postgres container name" name="container_name" placeholder="similarpng-postgres" required />
      <Field label="Postgres user" name="pg_user" placeholder="similarpng" required />
      <Field label="Postgres password" name="pg_password" type="password" required />
      <Field label="Postgres database" name="pg_database" placeholder="similarpng" required />
      <Field label="Postgres port (internal, default 5432)" name="pg_port" type="number" />
      <div class="flex gap-2 pt-2">
        <Btn type="submit" variant="primary">Create</Btn>
        <Btn href="/databases">Cancel</Btn>
      </div>
      <p class="text-xs text-slate-500 pt-2">
        The container must be reachable from the backup-manager — add its
        <code class="font-mono"> &lt;site&gt;_private </code> network to this stack's compose
        file and redeploy before pinging.
      </p>
    </form>
  </Card>
);

export const DatabaseDetail: FC<{ db: Database_; backups: Backup[] }> = ({ db, backups }) => (
  <Layout title={`Database: ${db.name}`} active="databases">
    <div class="space-y-6">
      <header class="flex items-end justify-between">
        <div>
          <h1 class="text-2xl font-bold">{db.name}</h1>
          <p class="text-sm text-slate-500 font-mono">{db.container_name} · {db.pg_user}@{db.pg_database}</p>
        </div>
        <div class="flex gap-2">
          <Btn
            hx={{
              "hx-post": `/databases/${db.id}/ping`,
              "hx-target": "#ping-result",
              "hx-swap": "innerHTML",
            }}
          >
            ping
          </Btn>
          <Btn href={`/databases/${db.id}/backup-now`} variant="primary">Backup now</Btn>
        </div>
      </header>
      <div id="ping-result"></div>

      <Card title={`Backups for ${db.name}`}>
        {backups.length === 0 ? (
          <p class="text-sm text-slate-500">No backups yet for this database.</p>
        ) : (
          <table class="w-full text-sm">
            <thead class="text-left text-slate-500 border-b">
              <tr>
                <th class="py-2">When</th>
                <th>Status</th>
                <th>Size</th>
                <th>S3 key</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr class="border-b last:border-0">
                  <td class="py-2 text-slate-500">{formatTime(b.started_at)}</td>
                  <td>
                    {b.status === "success" ? <Badge tone="success">success</Badge> :
                     b.status === "failed" ? <Badge tone="danger">failed</Badge> :
                     <Badge tone="info">running</Badge>}
                  </td>
                  <td>{b.size_bytes ? `${(b.size_bytes / 1024 / 1024).toFixed(1)} MB` : "—"}</td>
                  <td class="font-mono text-xs text-slate-500">{b.s3_key ?? "—"}</td>
                  <td class="text-right">
                    {b.status === "success" && (
                      <Btn href={`/backups/${b.id}/restore`} variant="secondary">restore</Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  </Layout>
);

const Field: FC<{
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  value?: string;
}> = ({ label, name, type = "text", placeholder, required, value }) => (
  <label class="block">
    <span class="block text-sm font-medium text-slate-700">{label}</span>
    <input
      class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border focus:outline-none focus:ring-2 focus:ring-slate-400"
      name={name}
      type={type}
      placeholder={placeholder}
      required={required}
      value={value}
    />
  </label>
);
