// Orchestrator: provision a new Postgres database end-to-end.
//
// 1. Reserve slug + random subdomain + next free host port
// 2. Create unproxied A record on Cloudflare (subdomain.<base> -> server IP)
// 3. Deploy Postgres stack via Portainer API (passes POSTGRES_DOMAIN env so the
//    image generates an SSL cert with CN = subdomain.<base>)
// 4. Wait for container to be running
// 5. Register the new DB in backup-manager's databases table so backups work
// 6. Return connection details (URL with sslmode=require)
//
// On failure at any step, roll back what was done so the user can retry cleanly.

import { provisioned, databases } from "./db.ts";
import type { ProvisionedPostgres } from "./db.ts";
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

const IMAGE = process.env.PROVISION_POSTGRES_IMAGE ?? "ghcr.io/dublyo/postgres";
const PORT_START = Number(process.env.PROVISION_PORT_START ?? 15432);
const PORT_END = Number(process.env.PROVISION_PORT_END ?? 15999);

export type ProvisionInput = {
  slugHint?: string;        // optional; auto-generated if blank
  pgVersion: "16" | "17" | "18";
  pgUser?: string;          // default "postgres"
  pgDatabase?: string;      // default "app"
};

export type ProvisionResult = {
  ok: boolean;
  id?: number;
  record?: ProvisionedPostgres;
  connectionUrl?: string;
  pgUser?: string;
  pgPassword?: string;
  pgDatabase?: string;
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

const COMPOSE_TEMPLATE = `services:
  postgres:
    image: \${POSTGRES_IMAGE}:\${POSTGRES_VERSION}
    container_name: \${SITE_NAME}-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB}
      POSTGRES_DOMAIN: \${POSTGRES_DOMAIN}
      POSTGRES_EXTENSIONS: uuid-ossp,pgcrypto,citext,hstore,pg_trgm,pg_stat_statements
      PGDATA: /var/lib/postgresql/data/pgdata
    command: >
      postgres
        -c ssl=on
        -c ssl_cert_file=/var/lib/postgresql/server.crt
        -c ssl_key_file=/var/lib/postgresql/server.key
        -c shared_preload_libraries=pg_stat_statements
        -c max_connections=100
        -c shared_buffers=128MB
        -c effective_cache_size=256MB
        -c work_mem=4MB
        -c maintenance_work_mem=64MB
        -c random_page_cost=1.1
        -c effective_io_concurrency=200
        -c log_min_duration_statement=1000
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "\${HOST_PORT}:5432"
    networks:
      - postgres_private
    labels:
      - traefik.enable=false
      - hosting.backup.enabled=true
      - hosting.backup.type=postgres
      - hosting.backup.site=\${SITE_NAME}
      - hosting.backup.database=\${POSTGRES_DB}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER} -d \${POSTGRES_DB}"]
      interval: 15s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 1G
        reservations:
          memory: 128M
          cpus: "0.25"
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "3"

volumes:
  postgres_data:

networks:
  postgres_private:
    name: \${SITE_NAME}_private
    internal: false
`;

export async function provisionPostgres(input: ProvisionInput): Promise<ProvisionResult> {
  if (!cfConfigured()) {
    return { ok: false, error: "Cloudflare not configured. Set CF_API_TOKEN + CF_ZONE_ID + CF_BASE_DOMAIN env vars." };
  }
  if (!portainerConfigured()) {
    return { ok: false, error: "Portainer not configured. Set PORTAINER_URL + PORTAINER_API_KEY env vars." };
  }

  // Resolve slug + subdomain. Auto-generated names follow the existing
  // dublyo.co convention: postgres-<8-hex>.
  let slug = (input.slugHint ?? "").trim().toLowerCase();
  if (!slug) {
    slug = randomSubdomain("postgres");
  } else if (!validSlug(slug)) {
    return {
      ok: false,
      error: `Invalid slug '${slug}'. Use lowercase letters, digits, hyphens; start with letter; 2-32 chars.`,
    };
  }

  // Allocate next free port
  let hostPort: number;
  try {
    hostPort = await nextFreePort(PORT_START, PORT_END);
  } catch (e: any) {
    return { ok: false, error: `port allocation: ${e.message}` };
  }

  const subdomain = slug; // 1:1 mapping
  const domain = fqdn(subdomain);
  const containerName = `${slug}-postgres`;
  const pgUser = input.pgUser || "postgres";
  const pgPassword = rndHex(16);
  const pgDatabase = input.pgDatabase || "app";

  // Insert tracking row (status='creating')
  const record = provisioned.create({
    slug,
    subdomain,
    domain,
    host_port: hostPort,
    pg_version: input.pgVersion,
    container_name: containerName,
  });

  // Track resources we create so we can roll back on failure
  let cfRecordId: string | null = null;
  let stackId: number | null = null;
  let dbId: number | null = null;

  try {
    // 1. Get server IP
    const ip = await serverPublicIp();

    // 2. Create CF A record (unproxied; raw TCP)
    // If a record by this name exists (re-provisioning), reuse instead of erroring.
    const existing = await findDnsRecord(domain);
    if (existing) {
      cfRecordId = existing.id;
    } else {
      const created = await createDnsRecord(subdomain, ip, false);
      cfRecordId = created.id;
    }

    // 3. Deploy Portainer stack
    const env: Record<string, string> = {
      SITE_NAME: slug,
      POSTGRES_IMAGE: IMAGE,
      POSTGRES_VERSION: input.pgVersion,
      POSTGRES_USER: pgUser,
      POSTGRES_PASSWORD: pgPassword,
      POSTGRES_DB: pgDatabase,
      POSTGRES_DOMAIN: domain,
      HOST_PORT: String(hostPort),
    };

    const stack = await deployStack(`${slug}-db`, COMPOSE_TEMPLATE, env);
    stackId = stack.Id;

    // 4. Wait for container to be running
    const waitRes = await waitForContainer(containerName, 90_000);
    if (!waitRes.running) {
      throw new Error(`container ${containerName} did not reach running state within 90s`);
    }

    // 5. Add to backup-manager's databases table
    const dbRow = databases.create({
      name: slug,
      container_name: containerName,
      pg_user: pgUser,
      pg_password: pgPassword,
      pg_database: pgDatabase,
      pg_port: 5432, // internal port (we exec inside container, not over TCP)
    });
    dbId = dbRow.id;

    // 6. Update tracking row to ready
    provisioned.update(record.id, {
      cf_record_id: cfRecordId,
      portainer_stack_id: stackId,
      database_id: dbId,
      status: "ready",
      error: null,
    });

    const connectionUrl = `postgresql://${pgUser}:${encodeURIComponent(pgPassword)}@${domain}:${hostPort}/${pgDatabase}?sslmode=require`;

    return {
      ok: true,
      id: record.id,
      record: { ...record, cf_record_id: cfRecordId, portainer_stack_id: stackId, database_id: dbId, status: "ready" },
      connectionUrl,
      pgUser,
      pgPassword,
      pgDatabase,
    };
  } catch (e: any) {
    const errMsg = e.message ?? String(e);
    provisioned.update(record.id, {
      cf_record_id: cfRecordId,
      portainer_stack_id: stackId,
      database_id: dbId,
      status: "failed",
      error: errMsg.slice(0, 2000),
    });

    // Best-effort rollback
    if (stackId !== null) {
      deleteStack(stackId).catch((err) => console.warn("[rollback stack]", err));
    }
    if (cfRecordId !== null) {
      deleteDnsRecord(cfRecordId).catch((err) => console.warn("[rollback dns]", err));
    }
    if (dbId !== null) {
      try { databases.remove(dbId); } catch {}
    }

    return { ok: false, id: record.id, error: errMsg };
  }
}

/**
 * Tear down a provisioned Postgres: stop the stack, delete the DNS record,
 * remove the database row from backup-manager. The DB volume is preserved
 * (Portainer doesn't auto-delete named volumes when removing a stack).
 */
export async function deprovisionPostgres(id: number): Promise<{ ok: boolean; error?: string }> {
  const rec = provisioned.get(id);
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
  if (rec.database_id) {
    try { databases.remove(rec.database_id); } catch {}
  }

  provisioned.update(id, {
    status: "deleted",
    error: firstErr ?? null,
  });
  return { ok: !firstErr, error: firstErr };
}
