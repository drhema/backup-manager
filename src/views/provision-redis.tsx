import type { FC } from "hono/jsx";
import { Layout, Card, Btn, Badge, formatTime } from "./layout.tsx";
import type { ProvisionedRedis } from "../db.ts";

export const ProvisionRedisList: FC<{
  items: ProvisionedRedis[];
  cfConfigured: boolean;
  portainerConfigured: boolean;
  baseDomain: string;
}> = ({ items, cfConfigured, portainerConfigured, baseDomain }) => (
  <Layout title="Provision Redis" active="provision-redis">
    <div class="space-y-6">
      <header class="flex items-end justify-between">
        <div>
          <h1 class="text-2xl font-bold">Provision Redis</h1>
          <p class="text-sm text-slate-500">TLS-encrypted Redis with auto self-signed cert on <code class="font-mono">*.{baseDomain || "(unconfigured)"}</code></p>
        </div>
        {cfConfigured && portainerConfigured && (
          <Btn href="/provision/redis/new" variant="primary">+ New Redis</Btn>
        )}
      </header>

      {(!cfConfigured || !portainerConfigured) && (
        <Card title="Configuration needed">
          <p class="text-sm text-slate-700">
            Set CF_API_TOKEN, CF_ZONE_ID, CF_BASE_DOMAIN, PORTAINER_API_KEY env vars (see Provision Postgres page for details).
          </p>
        </Card>
      )}

      <Card title="Provisioned Redis instances">
        {items.length === 0 ? (
          <p class="text-sm text-slate-500">None yet. Click <strong>+ New Redis</strong> to create one.</p>
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
              {items.map((r) => (
                <tr class="border-b last:border-0">
                  <td class="py-2 font-mono font-semibold">{r.slug}</td>
                  <td class="font-mono text-xs">{r.domain}:{r.host_port}</td>
                  <td>Redis {r.redis_version}</td>
                  <td>
                    {r.status === "ready" ? <Badge tone="success">ready</Badge> :
                     r.status === "creating" ? <Badge tone="info">creating</Badge> :
                     r.status === "failed" ? <Badge tone="danger">failed</Badge> :
                     <Badge tone="neutral">deleted</Badge>}
                  </td>
                  <td class="text-slate-500 text-xs">{formatTime(r.created_at)}</td>
                  <td class="text-right">
                    <Btn href={`/provision/redis/${r.id}`}>details</Btn>
                    {r.status === "ready" && (
                      <form method="post" action={`/provision/redis/${r.id}/delete`} class="inline"
                            onsubmit="return confirm('Tear down this Redis? Stack removed, DNS record deleted. Data volume kept.')">
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

export const ProvisionRedisForm: FC<{ baseDomain: string; portStart: number; portEnd: number }> = ({
  baseDomain,
  portStart,
  portEnd,
}) => (
  <Layout title="New Redis" active="provision-redis">
    <div class="space-y-6 max-w-xl">
      <header>
        <h1 class="text-2xl font-bold">New Redis instance</h1>
        <p class="text-sm text-slate-500">
          Creates a TLS-only Redis container with auto-generated self-signed cert
          on a random subdomain of <code class="font-mono">{baseDomain}</code>.
          Port auto-allocated from {portStart}–{portEnd}.
        </p>
      </header>

      <Card>
        <form method="post" action="/provision/redis/new" class="space-y-3">
          <label class="block">
            <span class="block text-sm font-medium text-slate-700">Slug</span>
            <input
              name="slug"
              placeholder="leave blank for redis-<8hex>"
              pattern="^[a-z][a-z0-9-]{0,30}[a-z0-9]$"
              class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border font-mono"
            />
          </label>

          <label class="block">
            <span class="block text-sm font-medium text-slate-700">Redis version</span>
            <select name="redis_version" class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border">
              <option value="7.4" selected>7.4 — Latest (recommended)</option>
              <option value="7.2">7.2 — LTS</option>
            </select>
          </label>

          <label class="block">
            <span class="block text-sm font-medium text-slate-700">Max memory (MB)</span>
            <input
              type="number"
              name="max_memory_mb"
              placeholder="256"
              value="256"
              min="32"
              class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border"
            />
            <span class="text-xs text-slate-500 mt-1 block">Eviction policy is <code>allkeys-lru</code> when memory fills.</span>
          </label>

          <label class="flex items-center gap-2 pt-1">
            <input type="checkbox" name="append_only" value="1" checked />
            <span class="text-sm text-slate-700">Enable AOF persistence (recommended for sessions/queues)</span>
          </label>

          <div class="flex gap-2 pt-2">
            <Btn type="submit" variant="primary">Create Redis</Btn>
            <Btn href="/provision/redis">Cancel</Btn>
          </div>
        </form>
      </Card>

      <div class="text-xs text-slate-500">
        <strong>Connecting:</strong> use <code>rediss://</code> URL scheme (double-s indicates TLS). Most clients
        accept that natively. From <code>redis-cli</code>: <code>redis-cli --tls --insecure -h ... -p ... -a ... ping</code>
        (<code>--insecure</code> skips cert chain verification — needed for self-signed; password still required).
      </div>
    </div>
  </Layout>
);

export const ProvisionRedisResult: FC<{
  record: ProvisionedRedis;
  connectionUrl?: string;
  password?: string;
  error?: string;
}> = ({ record, connectionUrl, password, error }) => (
  <Layout title={error ? "Provisioning failed" : "Redis ready"} active="provision-redis">
    <div class="space-y-6 max-w-2xl">
      <header>
        <h1 class="text-2xl font-bold">{error ? "Provisioning failed" : `${record.slug} ready ✓`}</h1>
        <p class="text-sm text-slate-500">Tracking ID #{record.id}</p>
      </header>

      {error && (
        <Card title="Error">
          <pre class="text-xs bg-red-50 border border-red-200 rounded p-3 whitespace-pre-wrap">{error}</pre>
        </Card>
      )}

      {!error && (
        <>
          <Card title="Connection URL" actions={<span class="text-xs text-slate-500">Save this — password shown once</span>}>
            <div class="font-mono text-xs bg-slate-900 text-slate-100 rounded p-3 break-all select-all">
              {connectionUrl}
            </div>
            <p class="text-xs text-slate-500 mt-2">
              <code>rediss://</code> (double-s) tells the client to use TLS. Use <code>?ssl=true</code> with
              clients that don't recognize the rediss scheme.
            </p>
          </Card>

          <Card title="Manual connection fields">
            <dl class="text-sm grid grid-cols-3 gap-y-2">
              <dt class="text-slate-500">Host</dt><dd class="col-span-2 font-mono">{record.domain}</dd>
              <dt class="text-slate-500">Port</dt><dd class="col-span-2 font-mono">{record.host_port}</dd>
              <dt class="text-slate-500">Username</dt><dd class="col-span-2 font-mono">default</dd>
              <dt class="text-slate-500">Password</dt><dd class="col-span-2 font-mono">{password}</dd>
              <dt class="text-slate-500">TLS</dt><dd class="col-span-2 font-mono">required (server self-signed)</dd>
              <dt class="text-slate-500">Container</dt><dd class="col-span-2 font-mono">{record.container_name}</dd>
              <dt class="text-slate-500">Version</dt><dd class="col-span-2 font-mono">Redis {record.redis_version}</dd>
            </dl>
          </Card>

          <Card title="redis-cli quick connect">
            <pre class="font-mono text-xs bg-slate-900 text-slate-100 rounded p-3 select-all whitespace-pre-wrap">
{`redis-cli --tls --insecure -h ${record.domain} -p ${record.host_port} -a '${password}' ping`}
            </pre>
          </Card>

          <div class="flex gap-2">
            <Btn href="/provision/redis" variant="primary">Back to list</Btn>
          </div>
        </>
      )}
    </div>
  </Layout>
);

export const ProvisionRedisDetail: FC<{ record: ProvisionedRedis }> = ({ record }) => (
  <Layout title={`Redis: ${record.slug}`} active="provision-redis">
    <div class="space-y-6 max-w-2xl">
      <header>
        <h1 class="text-2xl font-bold">{record.slug}</h1>
        <p class="text-sm text-slate-500 font-mono">{record.domain}:{record.host_port}</p>
      </header>

      <Card>
        <dl class="text-sm space-y-1">
          {row("Status", record.status)}
          {row("Container", record.container_name)}
          {row("Redis version", record.redis_version)}
          {row("Domain", record.domain)}
          {row("Host port", String(record.host_port))}
          {row("Password", record.password)}
          {row("CF DNS record ID", record.cf_record_id ?? "—")}
          {row("Portainer stack ID", record.portainer_stack_id !== null ? String(record.portainer_stack_id) : "—")}
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
      <dd class="font-mono break-all">{v}</dd>
    </div>
  );
}
