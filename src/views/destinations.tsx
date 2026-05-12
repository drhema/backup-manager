import type { FC } from "hono/jsx";
import { Layout, Card, Btn } from "./layout.tsx";
import type { Destination } from "../db.ts";

export const Destinations: FC<{ items: Destination[]; showForm?: boolean }> = ({
  items,
  showForm = false,
}) => (
  <Layout title="Destinations" active="destinations">
    <div class="space-y-6">
      <header class="flex items-end justify-between">
        <h1 class="text-2xl font-bold">Destinations (S3-compatible)</h1>
        {!showForm && <Btn href="/destinations?action=new" variant="primary">+ Add destination</Btn>}
      </header>

      {showForm && <NewDestinationForm />}

      <Card title="Configured destinations">
        {items.length === 0 ? (
          <p class="text-sm text-slate-500">No destinations yet.</p>
        ) : (
          <table class="w-full text-sm">
            <thead class="text-left text-slate-500 border-b">
              <tr>
                <th class="py-2">Name</th>
                <th>Type</th>
                <th>Endpoint</th>
                <th>Bucket / Prefix</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr class="border-b last:border-0">
                  <td class="py-2 font-mono font-semibold">{d.name}</td>
                  <td>{d.type.toUpperCase()}</td>
                  <td class="font-mono text-xs text-slate-500 truncate max-w-xs">{d.endpoint}</td>
                  <td class="font-mono text-xs">{d.bucket}/{d.path_prefix}</td>
                  <td class="text-right">
                    <Btn
                      hx={{
                        "hx-post": `/destinations/${d.id}/test`,
                        "hx-target": `#test-${d.id}`,
                        "hx-swap": "innerHTML",
                      }}
                    >
                      test
                    </Btn>
                    <span id={`test-${d.id}`} class="ml-2 text-xs"></span>
                    <Btn href={`/s3-browser?destination_id=${d.id}`}>browse</Btn>
                    <form method="post" action={`/destinations/${d.id}/delete`} class="inline" onsubmit="return confirm('Delete this destination? Existing backups in S3 stay; only the credentials are removed.')">
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

const NewDestinationForm: FC = () => (
  <Card title="Add destination">
    <form method="post" action="/destinations" class="space-y-3 max-w-xl">
      <Field label="Name" name="name" placeholder="primary-r2" required />
      <label class="block">
        <span class="block text-sm font-medium text-slate-700">Type</span>
        <select name="type" class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border">
          <option value="s3">S3-compatible (Cloudflare R2, MinIO, AWS S3)</option>
          <option value="b2">Backblaze B2 (S3-compatible endpoint)</option>
        </select>
      </label>
      <Field label="Endpoint URL" name="endpoint" placeholder="https://<account>.r2.cloudflarestorage.com" required />
      <Field label="Region" name="region" placeholder="auto" value="auto" />
      <Field label="Bucket" name="bucket" placeholder="my-backups" required />
      <Field label="Path prefix" name="path_prefix" placeholder="postgres/" value="postgres/" />
      <Field label="Access key" name="access_key" required />
      <Field label="Secret key" name="secret_key" type="password" required />
      <div class="flex gap-2 pt-2">
        <Btn type="submit" variant="primary">Create</Btn>
        <Btn href="/destinations">Cancel</Btn>
      </div>
      <p class="text-xs text-slate-500 pt-2">
        Tip: for Cloudflare R2, the endpoint looks like
        <code class="font-mono"> https://&lt;account-id&gt;.r2.cloudflarestorage.com</code>.
        Create an R2 API token scoped to one bucket with Object Read &amp; Write.
      </p>
    </form>
  </Card>
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
