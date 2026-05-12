import type { FC } from "hono/jsx";
import { Layout, Card, Btn, formatBytes, formatTime } from "./layout.tsx";
import type { Destination } from "../db.ts";
import type { S3Object } from "../s3.ts";

export const S3Browser: FC<{
  destinations: Destination[];
  selected: Destination | null;
  objects: S3Object[];
  prefix: string;
}> = ({ destinations, selected, objects, prefix }) => (
  <Layout title="S3 Browser" active="s3-browser">
    <div class="space-y-6">
      <header>
        <h1 class="text-2xl font-bold">S3 / R2 / B2 Browser</h1>
        <p class="text-sm text-slate-500">Inspect what's in your destination bucket. Read-only listing.</p>
      </header>

      <Card title="Pick destination">
        <form method="get" action="/s3-browser" class="flex gap-2 items-end">
          <label class="block flex-1">
            <span class="block text-sm text-slate-700">Destination</span>
            <select name="destination_id" class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border">
              <option value="">— select —</option>
              {destinations.map((d) => (
                <option value={d.id} selected={selected?.id === d.id}>
                  {d.name} ({d.bucket}/{d.path_prefix})
                </option>
              ))}
            </select>
          </label>
          <label class="block flex-1">
            <span class="block text-sm text-slate-700">Sub-prefix (optional)</span>
            <input
              name="prefix"
              value={prefix}
              placeholder="similarpng/"
              class="mt-1 block w-full rounded border-slate-300 shadow-sm text-sm py-2 px-3 border font-mono"
            />
          </label>
          <Btn type="submit" variant="primary">List</Btn>
        </form>
      </Card>

      {selected && (
        <Card title={`Objects in ${selected.bucket}/${selected.path_prefix}${prefix}`}>
          {objects.length === 0 ? (
            <p class="text-sm text-slate-500">No objects under this prefix.</p>
          ) : (
            <table class="w-full text-sm">
              <thead class="text-left text-slate-500 border-b">
                <tr>
                  <th class="py-2">Key</th>
                  <th>Size</th>
                  <th>Last modified</th>
                  <th class="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {objects.map((o) => (
                  <tr class="border-b last:border-0">
                    <td class="py-2 font-mono text-xs">{o.key}</td>
                    <td>{formatBytes(o.size)}</td>
                    <td class="text-slate-500 text-xs">{formatTime(o.lastModified.toISOString())}</td>
                    <td class="text-right">
                      <Btn href={`/s3-browser/download?destination_id=${selected.id}&key=${encodeURIComponent(o.key)}`}>download</Btn>
                      <form
                        method="post"
                        action={`/s3-browser/delete`}
                        class="inline"
                        onsubmit="return confirm('Delete this object permanently?')"
                      >
                        <input type="hidden" name="destination_id" value={String(selected.id)} />
                        <input type="hidden" name="key" value={o.key} />
                        <Btn type="submit" variant="danger">delete</Btn>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  </Layout>
);
