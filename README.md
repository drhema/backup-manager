# Backup Manager

Self-hosted web UI for Postgres backup/restore to S3-compatible storage (Cloudflare R2, Backblaze B2, AWS S3, MinIO). Designed to drop into the Portainer hosting platform — sits next to your site stacks, talks to each Postgres container via Docker exec, no postgres-client needed in this image.

## What it does

- **Add/remove databases** through a web UI — point at any Postgres container running on the same Docker host
- **Add/remove destinations** — S3-compatible buckets with per-site path prefix
- **Manual backup** on demand from the database page
- **Scheduled backups** via cron expressions with daily/weekly/monthly retention
- **Restore** from any past backup directly into the same or a different DB (with `--clean` confirm flag for destructive overwrite)
- **S3 browser** — inspect what's in your bucket, download or delete objects
- **CF Access JWT verification** (optional but recommended) so a leaked tunnel doesn't bypass auth

## Architecture

```
backup-manager  (this app)
├── Bun + Hono server (port 8085)
├── SQLite at /data/config.sqlite  (encrypted credentials at rest)
├── pg_dump / pg_restore via docker exec into target Postgres containers
├── AWS SDK v3 → R2/B2/S3 with multipart upload
├── Cron tick every 60s evaluates schedules
└── Server-rendered HTML (Hono JSX + HTMX + Tailwind CDN)

Networks:
- edge-public  (CF Tunnel reaches the app here)
- edge-egress  (uploads to S3/R2/B2)
- <site>_private  (one per site, so we can pg_dump exec into each <slug>-postgres)
```

## Deploy

### 1. Build + push the image (your GitHub repo)

```bash
git clone <your-fork-of-this>
cd backup-manager
git push origin main           # triggers .github/workflows/build-and-push.yml
```

The workflow tags + pushes to `ghcr.io/<your-org>/backup-manager:latest` and `:git-<sha>`. Set the GitHub repo Packages permissions to allow pulling from your server.

### 2. Generate the encryption key

Once per installation. Lose this key = all stored DB and S3 credentials are unrecoverable.

```bash
openssl rand -hex 32
```

### 3. Deploy as a Portainer stack

Portainer → Stacks → Add stack → Web editor → paste contents of `docker-compose.yml`.

**Required environment variables** (Portainer "Environment variables" tab):

| Variable | Value |
|---|---|
| `BACKUP_MANAGER_IMAGE` | `ghcr.io/<your-org>/backup-manager:latest` (or pinned `:git-<sha>`) |
| `ENCRYPTION_KEY` | The 32-byte hex string from step 2 |

**Optional** — pre-seed a default S3 destination so the UI shows an option on first load:

| Variable | Example |
|---|---|
| `DEFAULT_S3_NAME` | `primary-r2` |
| `DEFAULT_S3_ENDPOINT` | `https://77b837fe63915a67beb4a054abad0ee2.r2.cloudflarestorage.com` |
| `DEFAULT_S3_BUCKET` | `my-backups` |
| `DEFAULT_S3_ACCESS_KEY` | (R2 token, Object Read & Write) |
| `DEFAULT_S3_SECRET_KEY` | (R2 token secret) |
| `DEFAULT_S3_PATH_PREFIX` | `postgres/` |

**Optional** — Cloudflare Access JWT verification (strongly recommended for production):

| Variable | Value |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | e.g. `your-team.cloudflareaccess.com` (from CF Zero Trust → Settings → Custom Pages) |
| `CF_ACCESS_AUD_TAG` | The Application Audience (AUD) Tag, found on the Access app's overview page |

Deploy the stack. Container should reach `healthy` within ~20 seconds.

### 4. Add the CF Tunnel + Access route

In your existing Cloudflare Tunnel (`hosting-portainer-*`):

1. **Public Hostnames** → Add a hostname:
   - Subdomain: `backup`
   - Domain: `<your-domain>`
   - Service: `HTTP` → `backup-manager:8085`

2. **Access controls → Applications** → Add application → Self-hosted:
   - Name: `Backup Manager`
   - Domain: `backup.<your-domain>`
   - Session: 24h
   - Policy: Allow → Emails → your team emails

3. (Recommended) Copy the **AUD Tag** from the Access app overview and put it into the stack's `CF_ACCESS_AUD_TAG` env var, redeploy. This makes the app refuse any request whose JWT isn't signed by Cloudflare for *this* application.

### 5. Wire up each site's private network

So the backup-manager can `docker exec` into each `<slug>-postgres`, edit the stack's compose file to add the network at top level and to the service:

```yaml
networks:
  edge-public:
    external: true
  edge-egress:
    external: true
  similarpng_private:
    external: true
  myshop_private:
    external: true

services:
  backup-manager:
    networks:
      - edge-public
      - edge-egress
      - similarpng_private
      - myshop_private
```

Redeploy the stack each time you add a new site. The compose template has commented examples — uncomment as you onboard.

> **Why this is needed**: when pg_dump runs via `docker exec`, the actual pg traffic is over Docker's IPC, not network. So in principle backup-manager doesn't need to be on the site's network for pg_dump itself. However, the `pg_isready` ping in the UI's "ping" button uses the same network as the container, and future features (like SSL probes) will need it. Keep this pattern from day one.

## Using the UI

### Add a database

1. Open `https://backup.<your-domain>` → Databases → **+ Add database**
2. Fill in name (site slug), container name (`<slug>-postgres`), pg user/password/db
3. Save → click **ping** to confirm the credentials work
4. Click **backup now** to trigger an immediate manual backup

### Create a destination (if you didn't pre-seed)

1. Destinations → **+ Add destination**
2. Pick S3-compatible (Cloudflare R2 / MinIO / AWS S3) or B2
3. Endpoint URL, region (auto for R2), bucket, path prefix (e.g. `postgres/`)
4. Access key + secret key (R2 API token with Object Read & Write to the bucket)
5. Click **test** to verify

### Schedule daily backups

1. Schedules → **+ Add schedule**
2. Pick database + destination
3. Cron: `0 3 * * *` for daily 03:00 UTC. Format is standard 5-field cron, no slash-step.
4. Retention: keep 7 daily / 4 weekly / 6 monthly (defaults). Older backups are deleted from S3 automatically.
5. Save → it's enabled by default. Watch it run at the scheduled time.

### Restore a backup

1. Backups → click the backup → **restore**
2. Confirm target (defaults to the same DB as the backup origin — change in code if you need a different target)
3. Tick the "I understand" checkbox
4. If overwriting a populated DB, also tick **Destructive: --clean --if-exists**
5. Start restore. Watch `docker logs -f backup-manager` for progress.

### S3 Browser

Useful for finding old dumps not tracked in the local SQLite (e.g. from a previous server). Pick a destination, browse objects, download via signed URL or delete directly.

## Security model

| Concern | How it's handled |
|---|---|
| Auth on the UI | Cloudflare Access in front. Optional JWT verification (`CF_ACCESS_AUD_TAG`) inside the app. |
| Stored DB passwords | AES-256-GCM encrypted in SQLite with `ENCRYPTION_KEY` env. Lose the key = unrecoverable. |
| Stored S3 secrets | Same as above. |
| Docker socket access | Full read-write `/var/run/docker.sock`. Future hardening: docker-socket-proxy with `containers:read + exec:create` only. |
| Backup uploads | Sent over TLS via S3 SDK to your endpoint; no plaintext intermediate. |
| Backup downloads | Pre-signed URLs valid 10 min. |

## Local development

```bash
bun install
# Set env vars in a .env file (see .env.example)
bun run dev          # hot reload on src/* change
# UI at http://localhost:8085
```

For local docker socket access, mount the host socket:

```bash
docker run --rm -p 8085:8085 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v ./data:/data \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  ghcr.io/<your-org>/backup-manager:latest
```

## Limits and future work

- **No SSO yet**. CF Access is the auth layer. If you ever expose the app without CF Access in front, anyone on the network can use it.
- **No backup verification yet**. Future: per-backup automated restore into an ephemeral container with row-count sanity check.
- **No Telegram/Discord alerts on failed schedules yet**. Easy to add — wire a webhook into `scheduler.ts` after a failed `runBackup`.
- **No multi-host yet**. Each backup-manager instance manages backups for one server. Cross-host management would need either a central UI talking to multiple agents, or running this on every server independently.

## File map

```
backup-manager/
├── README.md                 (this file)
├── .env.example
├── package.json
├── tsconfig.json
├── Dockerfile
├── .dockerignore
├── docker-compose.yml        (Portainer deployment)
├── .github/workflows/build-and-push.yml
└── src/
    ├── index.ts              (Hono routes + scheduler boot)
    ├── auth.ts               (Cloudflare Access JWT verification)
    ├── crypto.ts             (AES-256-GCM for at-rest secrets)
    ├── db.ts                 (SQLite schema + CRUD)
    ├── pg.ts                 (pg_dump/pg_restore via docker exec)
    ├── s3.ts                 (AWS SDK wrappers; multipart upload)
    ├── backup.ts             (orchestrator + retention)
    ├── scheduler.ts          (cron loop)
    └── views/                (server-rendered JSX + HTMX)
        ├── layout.tsx
        ├── dashboard.tsx
        ├── databases.tsx
        ├── destinations.tsx
        ├── schedules.tsx
        ├── backups.tsx
        └── s3browser.tsx
```
