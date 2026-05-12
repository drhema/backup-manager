// Orchestrator: provision Typesense end-to-end.
//
// Different from Postgres/Redis: Typesense speaks HTTP, so we use the
// Cloudflare-proxied + Traefik pattern (like dublyo-api meilisearch template):
//   - DNS A record PROXIED through Cloudflare (orange cloud)
//   - CF terminates client HTTPS, talks to origin on port 443
//   - Traefik on origin routes by Host header to the typesense container
//   - No port published on the host, no UFW range needed
//   - URL is portless: https://typesense-<8hex>.<base-domain>
//
// SSL between CF and origin works in CF "Full" mode (any cert accepted) or
// "Full Strict" (requires valid origin cert installed in Traefik). Default
// platform setup uses self-signed fallback, which works in CF Full mode.

import { provisionedTypesense } from "./db.ts";
import type { ProvisionedTypesense } from "./db.ts";
import {
  cfConfigured,
  createDnsRecord,
  deleteDnsRecord,
  findDnsRecord,
  fqdn,
  randomSubdomain,
  serverPublicIp,
} from "./cloudflare.ts";
import {
  portainerConfigured,
  deployStack,
  deleteStack,
  waitForContainer,
} from "./portainer.ts";

const TYPESENSE_IMAGE = process.env.PROVISION_TYPESENSE_IMAGE ?? "typesense/typesense";

export type TypesenseProvisionInput = {
  slugHint?: string;
  typesenseVersion: string;     // e.g. "27.1", "0.25.2"
};

export type TypesenseProvisionResult = {
  ok: boolean;
  id?: number;
  record?: ProvisionedTypesense;
  url?: string;
  apiKey?: string;
  error?: string;
};

function rndHex(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function validSlug(s: string): boolean {
  return /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(s);
}

// HTTP service: no published port, Traefik labels route by Host header.
const COMPOSE_TEMPLATE = `services:
  typesense:
    image: \${TYPESENSE_IMAGE}:\${TYPESENSE_VERSION}
    container_name: \${SITE_NAME}-typesense
    restart: unless-stopped
    environment:
      TYPESENSE_API_KEY: \${TYPESENSE_API_KEY}
      TYPESENSE_DATA_DIR: /data
      TYPESENSE_API_PORT: "8108"
      TYPESENSE_API_ADDRESS: "0.0.0.0"
      TYPESENSE_ENABLE_CORS: "true"
    volumes:
      - typesense_data:/data
    networks:
      - edge-public
    labels:
      - traefik.enable=true
      - traefik.docker.network=edge-public
      - traefik.http.routers.\${SITE_NAME}.rule=Host(\`\${DOMAIN}\`)
      - traefik.http.routers.\${SITE_NAME}.entrypoints=websecure
      - traefik.http.routers.\${SITE_NAME}.tls=true
      - traefik.http.services.\${SITE_NAME}.loadbalancer.server.port=8108
      - hosting.provision.type=typesense
      - hosting.provision.site=\${SITE_NAME}
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 64M
          cpus: "0.1"
    # NO healthcheck: Traefik filters containers whose health status is
    # 'starting' or 'unhealthy', and the typesense image lacks bash + curl
    # for a working probe. Restart policy + docker's auto-recovery is enough.
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "3"

volumes:
  typesense_data:

networks:
  edge-public:
    external: true
`;

export async function provisionTypesense(input: TypesenseProvisionInput): Promise<TypesenseProvisionResult> {
  if (!cfConfigured()) {
    return { ok: false, error: "Cloudflare not configured." };
  }
  if (!portainerConfigured()) {
    return { ok: false, error: "Portainer not configured." };
  }

  let slug = (input.slugHint ?? "").trim().toLowerCase();
  if (!slug) {
    slug = randomSubdomain("typesense");
  } else if (!validSlug(slug)) {
    return {
      ok: false,
      error: `Invalid slug '${slug}'. Use lowercase letters, digits, hyphens; start with letter; 2-32 chars.`,
    };
  }

  const subdomain = slug;
  const domain = fqdn(subdomain);
  const containerName = `${slug}-typesense`;
  const apiKey = rndHex(16);

  const record = provisionedTypesense.create({
    slug,
    subdomain,
    domain,
    typesense_version: input.typesenseVersion,
    api_key: apiKey,
    container_name: containerName,
  });

  let cfRecordId: string | null = null;
  let stackId: number | null = null;

  try {
    const ip = await serverPublicIp();

    // Typesense over HTTP: proxied=true (orange cloud) — CF terminates SSL at edge.
    const existing = await findDnsRecord(domain);
    if (existing) {
      cfRecordId = existing.id;
    } else {
      const created = await createDnsRecord(subdomain, ip, true);   // PROXIED
      cfRecordId = created.id;
    }

    const env: Record<string, string> = {
      SITE_NAME: slug,
      TYPESENSE_IMAGE: TYPESENSE_IMAGE,
      TYPESENSE_VERSION: input.typesenseVersion,
      TYPESENSE_API_KEY: apiKey,
      DOMAIN: domain,
    };

    const stack = await deployStack(`${slug}-typesense`, COMPOSE_TEMPLATE, env);
    stackId = stack.Id;

    const waitRes = await waitForContainer(containerName, 60_000);
    if (!waitRes.running) {
      throw new Error(`container ${containerName} did not reach running state within 60s`);
    }

    provisionedTypesense.update(record.id, {
      cf_record_id: cfRecordId,
      portainer_stack_id: stackId,
      status: "ready",
      error: null,
    });

    const url = `https://${domain}`;

    return {
      ok: true,
      id: record.id,
      record: { ...record, cf_record_id: cfRecordId, portainer_stack_id: stackId, status: "ready" },
      url,
      apiKey,
    };
  } catch (e: any) {
    const errMsg = e.message ?? String(e);
    provisionedTypesense.update(record.id, {
      cf_record_id: cfRecordId,
      portainer_stack_id: stackId,
      status: "failed",
      error: errMsg.slice(0, 2000),
    });
    if (stackId !== null) deleteStack(stackId).catch(() => {});
    if (cfRecordId !== null) deleteDnsRecord(cfRecordId).catch(() => {});
    return { ok: false, id: record.id, error: errMsg };
  }
}

export async function deprovisionTypesense(id: number): Promise<{ ok: boolean; error?: string }> {
  const rec = provisionedTypesense.get(id);
  if (!rec) return { ok: false, error: "not found" };
  if (rec.status === "deleted") return { ok: true };

  let firstErr: string | undefined;
  if (rec.portainer_stack_id) {
    try { await deleteStack(rec.portainer_stack_id); }
    catch (e: any) { firstErr = firstErr ?? `stack delete: ${e.message}`; }
  }
  if (rec.cf_record_id) {
    try { await deleteDnsRecord(rec.cf_record_id); }
    catch (e: any) { firstErr = firstErr ?? `dns delete: ${e.message}`; }
  }
  provisionedTypesense.update(id, { status: "deleted", error: firstErr ?? null });
  return { ok: !firstErr, error: firstErr };
}
