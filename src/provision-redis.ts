// Orchestrator: provision a Redis instance end-to-end (parallel to provision.ts).
//
// 1. Reserve slug + random subdomain + next free host port (Redis range)
// 2. Create unproxied A record on Cloudflare
// 3. Deploy Portainer stack with ghcr.io/drhema/redis-tls
//    - Image generates self-signed cert from REDIS_DOMAIN env at startup
//    - Redis listens on TLS-only port (no plaintext)
//    - --requirepass set from REDIS_PASSWORD
// 4. Wait for container to be running
// 5. Return rediss:// URL with password

import { provisionedRedis } from "./db.ts";
import type { ProvisionedRedis } from "./db.ts";
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
  nextFreePort,
  waitForContainer,
} from "./portainer.ts";

const REDIS_IMAGE = process.env.PROVISION_REDIS_IMAGE ?? "ghcr.io/drhema/redis-tls";
const REDIS_PORT_START = Number(process.env.PROVISION_REDIS_PORT_START ?? 16379);
const REDIS_PORT_END = Number(process.env.PROVISION_REDIS_PORT_END ?? 16999);

export type RedisProvisionInput = {
  slugHint?: string;
  redisVersion: "7.4" | "7.2";
  maxMemoryMB?: number;     // default 256
  appendOnly?: boolean;     // default true
};

export type RedisProvisionResult = {
  ok: boolean;
  id?: number;
  record?: ProvisionedRedis;
  connectionUrl?: string;
  password?: string;
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

// Compose template — redis-tls image generates its own cert from REDIS_DOMAIN.
const COMPOSE_TEMPLATE = `services:
  redis:
    image: \${REDIS_IMAGE}:\${REDIS_VERSION}
    container_name: \${SITE_NAME}-redis
    restart: unless-stopped
    environment:
      REDIS_DOMAIN: \${REDIS_DOMAIN}
      REDIS_PASSWORD: \${REDIS_PASSWORD}
    command:
      - "--appendonly"
      - "\${APPEND_ONLY}"
      - "--maxmemory"
      - "\${MAX_MEMORY}"
      - "--maxmemory-policy"
      - "allkeys-lru"
    volumes:
      - redis_data:/data
      - redis_tls:/tls
    ports:
      - "\${HOST_PORT}:6379"
    networks:
      - redis_private
    labels:
      - traefik.enable=false
      - hosting.provision.type=redis
      - hosting.provision.site=\${SITE_NAME}
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 64M
          cpus: "0.1"
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "3"

volumes:
  redis_data:
  redis_tls:

networks:
  redis_private:
    name: \${SITE_NAME}_private
    internal: false
`;

export async function provisionRedis(input: RedisProvisionInput): Promise<RedisProvisionResult> {
  if (!cfConfigured()) {
    return { ok: false, error: "Cloudflare not configured." };
  }
  if (!portainerConfigured()) {
    return { ok: false, error: "Portainer not configured." };
  }

  // Resolve slug + subdomain
  let slug = (input.slugHint ?? "").trim().toLowerCase();
  if (!slug) {
    slug = randomSubdomain("redis");
  } else if (!validSlug(slug)) {
    return {
      ok: false,
      error: `Invalid slug '${slug}'. Use lowercase letters, digits, hyphens; start with letter; 2-32 chars.`,
    };
  }

  // Allocate next free port
  let hostPort: number;
  try {
    hostPort = await nextFreePort(REDIS_PORT_START, REDIS_PORT_END);
  } catch (e: any) {
    return { ok: false, error: `port allocation: ${e.message}` };
  }

  const subdomain = slug;
  const domain = fqdn(subdomain);
  const containerName = `${slug}-redis`;
  const password = rndHex(16);
  const maxMemory = `${input.maxMemoryMB ?? 256}mb`;
  const appendOnly = input.appendOnly === false ? "no" : "yes";

  const record = provisionedRedis.create({
    slug,
    subdomain,
    domain,
    host_port: hostPort,
    redis_version: input.redisVersion,
    password,
    container_name: containerName,
  });

  let cfRecordId: string | null = null;
  let stackId: number | null = null;

  try {
    const ip = await serverPublicIp();

    // Reuse existing DNS record if one was orphaned from a previous attempt
    const existing = await findDnsRecord(domain);
    if (existing) {
      cfRecordId = existing.id;
    } else {
      const created = await createDnsRecord(subdomain, ip, false);
      cfRecordId = created.id;
    }

    const env: Record<string, string> = {
      SITE_NAME: slug,
      REDIS_IMAGE: REDIS_IMAGE,
      REDIS_VERSION: input.redisVersion,
      REDIS_PASSWORD: password,
      REDIS_DOMAIN: domain,
      HOST_PORT: String(hostPort),
      MAX_MEMORY: maxMemory,
      APPEND_ONLY: appendOnly,
    };

    const stack = await deployStack(`${slug}-redis`, COMPOSE_TEMPLATE, env);
    stackId = stack.Id;

    const waitRes = await waitForContainer(containerName, 60_000);
    if (!waitRes.running) {
      throw new Error(`container ${containerName} did not reach running state within 60s`);
    }

    provisionedRedis.update(record.id, {
      cf_record_id: cfRecordId,
      portainer_stack_id: stackId,
      status: "ready",
      error: null,
    });

    // rediss:// (double-s) tells clients to use TLS. AUTH happens after TLS handshake.
    const connectionUrl = `rediss://default:${encodeURIComponent(password)}@${domain}:${hostPort}`;

    return {
      ok: true,
      id: record.id,
      record: { ...record, cf_record_id: cfRecordId, portainer_stack_id: stackId, status: "ready" },
      connectionUrl,
      password,
    };
  } catch (e: any) {
    const errMsg = e.message ?? String(e);
    provisionedRedis.update(record.id, {
      cf_record_id: cfRecordId,
      portainer_stack_id: stackId,
      status: "failed",
      error: errMsg.slice(0, 2000),
    });

    if (stackId !== null) {
      deleteStack(stackId).catch((err) => console.warn("[redis rollback stack]", err));
    }
    if (cfRecordId !== null) {
      deleteDnsRecord(cfRecordId).catch((err) => console.warn("[redis rollback dns]", err));
    }

    return { ok: false, id: record.id, error: errMsg };
  }
}

export async function deprovisionRedis(id: number): Promise<{ ok: boolean; error?: string }> {
  const rec = provisionedRedis.get(id);
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

  provisionedRedis.update(id, {
    status: "deleted",
    error: firstErr ?? null,
  });
  return { ok: !firstErr, error: firstErr };
}
