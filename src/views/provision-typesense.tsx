import type { FC } from "hono/jsx";
import { Layout, Card, Btn, Badge, formatTime } from "./layout.tsx";
import type { ProvisionedTypesense } from "../db.ts";

export const ProvisionTypesenseList: FC<{
  items: ProvisionedTypesense[];
  cfConfigured: boolean;
  portainerConfigured: boolean;
  baseDomain: string;
}> = ({ items, cfConfigured, portainerConfigured, baseDomain }) => (
  <Layout title="Provision Typesense" active="provision-typesense">
    <div class="space-y-6">
      <header class="flex items-end justify-between">
        <div>
          <h1 class="text-2xl font-bold">Provision Typesense</h1>
          <p class="text-sm text-slate-500">HTTP search API on <code class="font-mono">https://typesense-&lt;8hex&gt;.{baseDomain || "(unconfigured)"}</code> — CF proxy handles SSL, no port.</p>
        </div>
        {cfConfigured && portainerConfigured && (
          <Btn href="/provision/typesense/new" variant="primary">+ New Typesense</Btn>
        )}
      </header>

      {(!cfConfigured || !portainerConfigured) && (
        <Card title="Configuration needed">
          <p class="text-sm text-slate-700">Set CF and Portainer env vars first (see Provision Postgres page).</p>
        </Card>
      )}

      <Card title="Provisioned Typesense instances">
        {items.length === 0 ? (
          <p class="text-sm text-slate-500">None yet. Click <strong>+ New Typesense</strong>.</p>
        ) : (
          <table class="w-full text-sm">
            <thead class="text-left text-slate-500 border-b">
              <tr>
                <th class="py-2">Slug</th>
                <th>URL</th>
                <th>Version</th>
                <th>Status</th>
                <th>Created</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr class="border-b last:border-0">
                  <td class="py-2 font-mono font-semibold">{t.slug}</td>
                  <td class="font-mono text-xs">https://{t.domain}</td>
                  <td>{t.typesense_version}</td>
                  <td>
                    {t.status === "ready" ? <Badge tone="success">ready</Badge> :
                     t.status === "creating" ? <Badge tone="info">creating</Badge> :
                     t.status === "failed" ? <Badge tone="danger">failed</Badge> :
                     <Badge tone="neutral">deleted</Badge>}
                  </td>
                  <td class="text-slate-500 text-xs">{formatTime(t.created_at)}</td>
                  <td class="text-right">
                    <Btn href={`/provision/typesense/${t.id}`}>details</Btn>
                    {t.status === "ready" && (
                      <form method="post" action={`/provision/typesense/${t.id}/delete`} class="inline"
                            onsubmit="return confirm('Tear down? Stack + DNS removed. Data volume kept.')">
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

export const ProvisionTypesenseForm: FC<{ baseDomain: string }> = ({ baseDomain }) => (
  <Layout title="New Typesense" active="provision-typesense">
    <div class="space-y-6 max-w-xl">
      <header>
        <h1 class="text-2xl font-bold">New Typesense instance</h1>
        <p class="text-sm text-slate-500">
          Creates a Typesense container on a random subdomain of <code class="font-mono">{baseDomain}</code>.
          DNS is proxied through Cloudflare (HTTPS at edge), no port in the URL.
        </p>
      </header>

      <Card>
        <form method="post" action="/provision/typesense/new" class="space-y-3">
          <label class="block">
            <span class="block text-sm font-medium text-slate-700">Slug</span>
            <input
              name="slug"
              placeholder="leave blank for typesense-<8hex>"
              pattern="^[a-z][a-z0-9-]{0,30}[a-z0-9]$"
              class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border font-mono"
            />
          </label>

          <label class="block">
            <span class="block text-sm font-medium text-slate-700">Typesense version</span>
            <select name="typesense_version" class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border">
              <option value="27.1" selected>27.1 — Latest stable</option>
              <option value="26.0">26.0</option>
              <option value="0.25.2">0.25.2 — Legacy</option>
            </select>
            <span class="text-xs text-slate-500 mt-1 block">Newer (≥27) supports embeddings + LLM features. 0.25.2 matches existing dublyo-api stacks.</span>
          </label>

          <div class="flex gap-2 pt-2">
            <Btn type="submit" variant="primary">Create Typesense</Btn>
            <Btn href="/provision/typesense">Cancel</Btn>
          </div>
        </form>
      </Card>

      <div class="text-xs text-slate-500">
        <strong>Cloudflare SSL mode:</strong> works in "Full" mode (CF accepts any origin cert).
        For "Full Strict", install a wildcard CF origin cert for <code>*.{baseDomain}</code> in
        <code> /opt/hosting/certs/</code> and add a Traefik dynamic TLS file referencing it.
      </div>
    </div>
  </Layout>
);

export const ProvisionTypesenseResult: FC<{
  record: ProvisionedTypesense;
  url?: string;
  apiKey?: string;
  error?: string;
}> = ({ record, url, apiKey, error }) => (
  <Layout title={error ? "Provisioning failed" : "Typesense ready"} active="provision-typesense">
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
          <Card title="API URL" actions={<span class="text-xs text-slate-500">Save key — shown once</span>}>
            <div class="font-mono text-xs bg-slate-900 text-slate-100 rounded p-3 break-all select-all">
              {url}
            </div>
          </Card>

          <Card title="API key (X-TYPESENSE-API-KEY header)">
            <div class="font-mono text-xs bg-slate-900 text-slate-100 rounded p-3 break-all select-all">
              {apiKey}
            </div>
          </Card>

          <Card title="Quick test (after DNS propagates, ~30s)">
            <pre class="font-mono text-xs bg-slate-900 text-slate-100 rounded p-3 whitespace-pre-wrap select-all">
{`curl -H "X-TYPESENSE-API-KEY: ${apiKey}" \\
     ${url}/health`}
            </pre>
            <p class="text-xs text-slate-500 mt-2">
              Expected response: <code>{`{"ok":true}`}</code>
            </p>
          </Card>

          <Card title="Manual fields">
            <dl class="text-sm grid grid-cols-3 gap-y-2">
              <dt class="text-slate-500">Host</dt><dd class="col-span-2 font-mono">{record.domain}</dd>
              <dt class="text-slate-500">Protocol</dt><dd class="col-span-2 font-mono">HTTPS (via CF)</dd>
              <dt class="text-slate-500">API key</dt><dd class="col-span-2 font-mono">{apiKey}</dd>
              <dt class="text-slate-500">Container</dt><dd class="col-span-2 font-mono">{record.container_name}</dd>
              <dt class="text-slate-500">Version</dt><dd class="col-span-2 font-mono">{record.typesense_version}</dd>
            </dl>
          </Card>

          <div class="flex gap-2">
            <Btn href="/provision/typesense" variant="primary">Back to list</Btn>
          </div>
        </>
      )}
    </div>
  </Layout>
);

export const ProvisionTypesenseDetail: FC<{ record: ProvisionedTypesense }> = ({ record }) => (
  <Layout title={`Typesense: ${record.slug}`} active="provision-typesense">
    <div class="space-y-6 max-w-2xl">
      <header>
        <h1 class="text-2xl font-bold">{record.slug}</h1>
        <p class="text-sm text-slate-500 font-mono">https://{record.domain}</p>
      </header>

      <Card>
        <dl class="text-sm space-y-1">
          {row("Status", record.status)}
          {row("Container", record.container_name)}
          {row("Version", record.typesense_version)}
          {row("Domain", record.domain)}
          {row("API key", record.api_key)}
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
