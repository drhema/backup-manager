# =============================================================================
# Backup Manager — Bun + Hono single-image build
# =============================================================================
FROM oven/bun:1.1-alpine AS builder
WORKDIR /app

# Install deps (cached layer)
COPY package.json ./
# Include bun.lock if it exists in the repo (improves reproducibility); skipped otherwise.
COPY bun.loc[k] ./
RUN bun install

# Copy source and typecheck
COPY tsconfig.json ./
COPY src ./src
RUN bunx tsc --noEmit

# Runtime image
FROM oven/bun:1.1-alpine AS runtime
WORKDIR /app

# Install postgres-client for pg_dump/pg_restore commands run via docker exec on
# remote containers — we don't actually need pg tools in this image because we
# exec inside the target Postgres container. Skip unless future need arises.

# Non-root user for runtime
RUN addgroup -S app && adduser -S app -G app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Persistent data: SQLite config DB + scratch dir for in-flight backups
RUN mkdir -p /data /scratch && chown -R app:app /data /scratch /app
USER app

ENV NODE_ENV=production
ENV PORT=8085
ENV DATA_DIR=/data
ENV SCRATCH_DIR=/scratch
EXPOSE 8085

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8085/healthz || exit 1

CMD ["bun", "run", "src/index.ts"]
