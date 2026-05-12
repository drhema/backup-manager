// Cloudflare DNS API client — minimal port of dublyo-api/internal/services/cloudflare.go.
// Used by the provision flow to create unproxied A records for new Postgres subdomains.

const CF_API_TOKEN = process.env.CF_API_TOKEN ?? "";
const CF_ZONE_ID = process.env.CF_ZONE_ID ?? "";
const CF_BASE_DOMAIN = process.env.CF_BASE_DOMAIN ?? "";

export function cfConfigured(): boolean {
  return CF_API_TOKEN !== "" && CF_ZONE_ID !== "" && CF_BASE_DOMAIN !== "";
}

export type DnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
};

const BASE = "https://api.cloudflare.com/client/v4";

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${CF_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function cfFetch<T = any>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const r = await fetch(BASE + path, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
  const body = (await r.json()) as any;
  if (!body.success) {
    const msgs = (body.errors ?? []).map((e: any) => e.message).join(", ");
    throw new Error(`Cloudflare API error (HTTP ${r.status}): ${msgs || JSON.stringify(body)}`);
  }
  return body.result as T;
}

/**
 * Create a DNS A record. `subdomain` is the leftmost label only (e.g. "pg-abc12345").
 * proxied=false (gray cloud) is REQUIRED for raw TCP services like Postgres —
 * CF proxy is HTTP-only on free/pro/business tiers.
 */
export async function createDnsRecord(
  subdomain: string,
  ip: string,
  proxied = false,
): Promise<DnsRecord> {
  // Strip any accidental .domain suffix
  const name = subdomain.endsWith(`.${CF_BASE_DOMAIN}`)
    ? subdomain.slice(0, -1 - CF_BASE_DOMAIN.length)
    : subdomain;

  const record = await cfFetch<DnsRecord>(`/zones/${CF_ZONE_ID}/dns_records`, {
    method: "POST",
    body: JSON.stringify({
      type: "A",
      name,
      content: ip,
      ttl: 1, // automatic
      proxied,
    }),
  });
  return record;
}

export async function findDnsRecord(name: string): Promise<DnsRecord | null> {
  const fullName = name.endsWith(`.${CF_BASE_DOMAIN}`) ? name : `${name}.${CF_BASE_DOMAIN}`;
  const url = `/zones/${CF_ZONE_ID}/dns_records?type=A&name=${encodeURIComponent(fullName)}`;
  const list = await cfFetch<DnsRecord[]>(url);
  return list[0] ?? null;
}

export async function deleteDnsRecord(recordId: string): Promise<void> {
  await cfFetch(`/zones/${CF_ZONE_ID}/dns_records/${recordId}`, { method: "DELETE" });
}

/** Build the FQDN for a subdomain on the configured base. */
export function fqdn(subdomain: string): string {
  return `${subdomain}.${CF_BASE_DOMAIN}`;
}

/**
 * Generate a random subdomain matching the existing dublyo.co pattern:
 *   postgres-<8 hex chars>
 * e.g. postgres-26df2af5
 */
export function randomSubdomain(prefix = "postgres"): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex}`;
}

let _cachedIp: string | null = null;

/**
 * Return this server's public IPv4. Pinned via SERVER_PUBLIC_IP env, or fetched
 * once from api.ipify.org and cached.
 */
export async function serverPublicIp(): Promise<string> {
  if (process.env.SERVER_PUBLIC_IP) return process.env.SERVER_PUBLIC_IP;
  if (_cachedIp) return _cachedIp;
  const r = await fetch("https://api.ipify.org");
  if (!r.ok) throw new Error(`Could not auto-detect public IP: HTTP ${r.status}`);
  _cachedIp = (await r.text()).trim();
  return _cachedIp;
}
