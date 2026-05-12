import type { FC } from "hono/jsx";
import { Layout, Card, Btn, Badge, formatTime } from "./layout.tsx";
import type { ProvisionedPostgres } from "../db.ts";

export const ProvisionList: FC<{
  items: ProvisionedPostgres[];
  cfConfigured: boolean;
  portainerConfigured: boolean;
  baseDomain: string;
}> = ({ items, cfConfigured, portainerConfigured, baseDomain }) => (
  <Layout title="Provision Postgres" active="provision">
    <div class="space-y-6">
      <header class="flex items-end justify-between">
        <div>
          <h1 class="text-2xl font-bold">Provision Postgres</h1>
          <p class="text-sm text-slate-500">One-click create a Postgres database with auto DNS + SSL on <code class="font-mono">*.{baseDomain || "(unconfigured)"}</code></p>
        </div>
        {cfConfigured && portainerConfigured && (
          <Btn href="/provision/new" variant="primary">+ New Postgres</Btn>
        )}
      </header>

      {(!cfConfigured || !portainerConfigured) && (
        <Card title="Configuration needed">
          <p class="text-sm text-slate-700 mb-3">
            Set these env vars on the <code>backup-manager</code> stack in Portainer, then redeploy:
          </p>
          <ul class="text-sm font-mono space-y-1 text-slate-700">
            {!cfConfigured && (
              <>
                <li class="text-red-700">CF_API_TOKEN={" "}<span class="text-slate-500"># Cloudflare token with Zone:DNS:Edit</span></li>
                <li class="text-red-700">CF_ZONE_ID=...</li>
                <li class="text-red-700">CF_BASE_DOMAIN=ph4world.com</li>
              </>
            )}
            {!portainerConfigured && (
              <>
                <li class="text-red-700">PORTAINER_API_KEY=ptr_...</li>
                <li class="text-red-700">PORTAINER_URL=http://portainer:9000</li>
                <li class="text-red-700">PORTAINER_ENDPOINT_ID=3</li>
              </>
            )}
          </ul>
        </Card>
      )}

      <Card title="Provisioned databases">
        {items.length === 0 ? (
          <p class="text-sm text-slate-500">None yet. Click <strong>+ New Postgres</strong> to create one.</p>
        ) : (
          <table class="w-full text-sm">
            <thead class="text-left text-slate-500 border-b">
              <tr>
                <th class="py-2">Slug</th>
                <th>Domain : port</th>
                <th>Version</th>
                <th>Status</th>
                <th>Created</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr class="border-b last:border-0">
                  <td class="py-2 font-mono font-semibold">{p.slug}</td>
                  <td class="font-mono text-xs">{p.domain}:{p.host_port}</td>
                  <td>PG {p.pg_version}</td>
                  <td>
                    {p.status === "ready" ? <Badge tone="success">ready</Badge> :
                     p.status === "creating" ? <Badge tone="info">creating</Badge> :
                     p.status === "failed" ? <Badge tone="danger">failed</Badge> :
                     <Badge tone="neutral">deleted</Badge>}
                  </td>
                  <td class="text-slate-500 text-xs">{formatTime(p.created_at)}</td>
                  <td class="text-right">
                    <Btn href={`/provision/${p.id}`}>details</Btn>
                    {p.status === "ready" && (
                      <form method="post" action={`/provision/${p.id}/delete`} class="inline"
                            onsubmit="return confirm('Tear down this Postgres? Stack will be removed, DNS record deleted. Postgres data VOLUME is kept.')">
                        <Btn type="submit" variant="danger">tear down</Btn>
                      </form>
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

export const ProvisionForm: FC<{ baseDomain: string; portStart: number; portEnd: number }> = ({
  baseDomain,
  portStart,
  portEnd,
}) => (
  <Layout title="New Postgres" active="provision">
    <div class="space-y-6 max-w-xl">
      <header>
        <h1 class="text-2xl font-bold">New Postgres database</h1>
        <p class="text-sm text-slate-500">Creates a Postgres container on this server with auto SSL on a random subdomain of <code class="font-mono">{baseDomain}</code>. Port is auto-allocated from the {portStart}–{portEnd} range.</p>
      </header>

      <Card>
        <form method="post" action="/provision/new" class="space-y-3">
          <label class="block">
            <span class="block text-sm font-medium text-slate-700">Slug</span>
            <input
              name="slug"
              placeholder="leave blank to auto-generate (e.g. pg-abc12345)"
              pattern="^[a-z][a-z0-9-]{0,30}[a-z0-9]$"
              class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border font-mono"
            />
            <span class="text-xs text-slate-500 mt-1 block">Lowercase letters/digits/hyphens; 2-32 chars. Used as subdomain + container name.</span>
          </label>

          <label class="block">
            <span class="block text-sm font-medium text-slate-700">Postgres version</span>
            <select name="pg_version" class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border">
              <option value="18" selected>18 — Newest</option>
              <option value="17">17 — Stable</option>
              <option value="16">16 — LTS</option>
            </select>
          </label>

          <label class="block">
            <span class="block text-sm font-medium text-slate-700">Database name</span>
            <input
              name="pg_database"
              placeholder="app"
              value="app"
              class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border font-mono"
            />
          </label>

          <label class="block">
            <span class="block text-sm font-medium text-slate-700">Superuser</span>
            <input
              name="pg_user"
              placeholder="postgres"
              value="postgres"
              class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border font-mono"
            />
            <span class="text-xs text-slate-500 mt-1 block">Password is auto-generated (32 hex chars) and shown once on the next page.</span>
          </label>

          <div class="flex gap-2 pt-2">
            <Btn type="submit" variant="primary">Create database</Btn>
            <Btn href="/provision">Cancel</Btn>
          </div>
        </form>
      </Card>

      <div class="text-xs text-slate-500">
        <strong>What this does:</strong> creates an unproxied A record at Cloudflare → server IP, deploys a Portainer stack with the
        custom Postgres image (SSL enabled, cert CN matches the subdomain), and registers the new DB in backup-manager so it can be
        backed up immediately.
      </div>
    </div>
  </Layout>
);

export const ProvisionResult: FC<{
  record: ProvisionedPostgres;
  connectionUrl?: string;
  pgUser?: string;
  pgPassword?: string;
  pgDatabase?: string;
  error?: string;
}> = ({ record, connectionUrl, pgUser, pgPassword, pgDatabase, error }) => (
  <Layout title={error ? "Provisioning failed" : "Provisioning succeeded"} active="provision">
    <div class="space-y-6 max-w-2xl">
      <header>
        <h1 class="text-2xl font-bold">{error ? "Provisioning failed" : `${record.slug} ready ✓`}</h1>
        <p class="text-sm text-slate-500">Tracking ID #{record.id}</p>
      </header>

      {error && (
        <Card title="Error">
          <pre class="text-xs bg-red-50 border border-red-200 rounded p-3 whitespace-pre-wrap">{error}</pre>
          <p class="text-sm text-slate-600 mt-3">
            Any partially-created resources have been rolled back. Click <a href="/provision/new" class="text-sky-700 underline">try again</a>.
          </p>
        </Card>
      )}

      {!error && (
        <>
          <Card title="Connection string" actions={<span class="text-xs text-slate-500">Save this — password is shown once</span>}>
            <div class="font-mono text-xs bg-slate-900 text-slate-100 rounded p-3 break-all select-all">
              {connectionUrl}
            </div>
            <p class="text-xs text-slate-500 mt-2">
              Uses <code>sslmode=require</code> — TLS is enforced, but no cert chain verification (the image generates a self-signed cert).
              To use <code>sslmode=verify-full</code>, install the server cert in your client's trust store.
            </p>
          </Card>

          <Card title="Manual connection fields">
            <dl class="text-sm grid grid-cols-3 gap-y-2">
              <dt class="text-slate-500">Host</dt><dd class="col-span-2 font-mono">{record.domain}</dd>
              <dt class="text-slate-500">Port</dt><dd class="col-span-2 font-mono">{record.host_port}</dd>
              <dt class="text-slate-500">Database</dt><dd class="col-span-2 font-mono">{pgDatabase}</dd>
              <dt class="text-slate-500">User</dt><dd class="col-span-2 font-mono">{pgUser}</dd>
              <dt class="text-slate-500">Password</dt><dd class="col-span-2 font-mono">{pgPassword}</dd>
              <dt class="text-slate-500">SSL</dt><dd class="col-span-2 font-mono">require</dd>
              <dt class="text-slate-500">Container</dt><dd class="col-span-2 font-mono">{record.container_name}</dd>
              <dt class="text-slate-500">PG version</dt><dd class="col-span-2 font-mono">{record.pg_version}</dd>
            </dl>
          </Card>

          <Card title="What was created">
            <ul class="text-sm space-y-1 text-slate-700">
              <li>✅ Cloudflare A record (unproxied): <code class="font-mono">{record.domain}</code></li>
              <li>✅ Portainer stack: <code class="font-mono">{record.slug}-db</code></li>
              <li>✅ backup-manager database entry — go to <a href="/databases" class="text-sky-700 underline">Databases</a> to verify, then <a href="/schedules?action=new" class="text-sky-700 underline">add a backup schedule</a>.</li>
            </ul>
          </Card>

          <div class="flex gap-2">
            <Btn href="/provision" variant="primary">Back to list</Btn>
            <Btn href="/schedules?action=new">Create backup schedule</Btn>
          </div>
        </>
      )}
    </div>
  </Layout>
);

export const ProvisionDetail: FC<{ record: ProvisionedPostgres }> = ({ record }) => (
  <Layout title={`Postgres: ${record.slug}`} active="provision">
    <div class="space-y-6 max-w-2xl">
      <header>
        <h1 class="text-2xl font-bold">{record.slug}</h1>
        <p class="text-sm text-slate-500 font-mono">{record.domain}:{record.host_port}</p>
      </header>

      <Card>
        <dl class="text-sm space-y-1">
          {row("Status", record.status)}
          {row("Container", record.container_name)}
          {row("Postgres version", record.pg_version)}
          {row("Subdomain", record.subdomain)}
          {row("Full domain", record.domain)}
          {row("Host port", String(record.host_port))}
          {row("CF DNS record ID", record.cf_record_id ?? "—")}
          {row("Portainer stack ID", record.portainer_stack_id !== null ? String(record.portainer_stack_id) : "—")}
          {row("backup-manager DB id", record.database_id !== null ? String(record.database_id) : "—")}
          {row("Created", formatTime(record.created_at))}
        </dl>
        {record.error && (
          <div class="mt-4">
            <h3 class="text-sm font-semibold text-red-700">Last error</h3>
            <pre class="text-xs bg-red-50 border border-red-200 rounded p-3 mt-1 whitespace-pre-wrap">{record.error}</pre>
          </div>
        )}
      </Card>
    </div>
  </Layout>
);

function row(k: string, v: string) {
  return (
    <div class="flex border-b last:border-0 py-1.5">
      <dt class="w-1/3 text-slate-500">{k}</dt>
      <dd class="font-mono">{v}</dd>
    </div>
  );
}
