// pg_dump / pg_restore / pg_isready via `docker exec` calling the Docker CLI
// installed in this image. We don't use a Node Docker client library because
// docker-modem (dockerode's HTTP layer) chokes on the HTTP 101 Switching
// Protocols response that Docker uses for streaming exec — Bun's HTTP stack
// surfaces it as "(HTTP code 101) unexpected". Shelling out to the docker CLI
// avoids the whole class of HTTP-streaming compat issues.
//
// The container needs:
//   - /var/run/docker.sock mounted
//   - membership in the host's `docker` group (use `group_add: ["<docker_gid>"]`
//     in docker-compose since the GID varies per host; common values are 988
//     and 999 depending on Ubuntu version)
//   - the `docker` CLI binary installed (apk add docker-cli)

import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { Database_ } from "./db.ts";

export type DumpResult = {
  ok: boolean;
  bytes: number;
  sha256: string;
  error?: string;
};

/**
 * Stream pg_dump output from a target Postgres container to a writable stream.
 * Returns when pg_dump exits. Counts bytes + computes sha256 in transit.
 */
export async function streamDump(
  database: Database_,
  out: Writable,
): Promise<DumpResult> {
  const proc = Bun.spawn(
    [
      "docker",
      "exec",
      "-i",
      "--env",
      `PGPASSWORD=${database.pg_password}`,
      database.container_name,
      "pg_dump",
      "-U",
      database.pg_user,
      "-d",
      database.pg_database,
      "-Fc",
      "-Z",
      "6",
      "--no-owner",
      "--no-privileges",
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  let bytes = 0;
  const hash = createHash("sha256");

  try {
    const reader = proc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        bytes += value.byteLength;
        hash.update(value);
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((res) => out.once("drain", () => res()));
        }
      }
    }
    out.end();
  } catch (e: any) {
    return { ok: false, bytes, sha256: hash.digest("hex"), error: `stream error: ${e.message}` };
  }

  const exitCode = await proc.exited;
  const sha256 = hash.digest("hex");

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    return { ok: false, bytes, sha256, error: `pg_dump exit ${exitCode}: ${stderr.trim() || "(no stderr)"}` };
  }

  return { ok: true, bytes, sha256 };
}

/**
 * Pipe a dump file (custom format) into pg_restore inside the target container.
 * cleanFirst=true adds --clean --if-exists (destructive).
 */
export async function streamRestore(
  database: Database_,
  input: Readable,
  cleanFirst = false,
): Promise<{ ok: boolean; error?: string }> {
  const cmd = [
    "docker",
    "exec",
    "-i",
    "--env",
    `PGPASSWORD=${database.pg_password}`,
    database.container_name,
    "pg_restore",
    "-U",
    database.pg_user,
    "-d",
    database.pg_database,
    "--no-owner",
    "--role",
    database.pg_user,
  ];
  if (cleanFirst) cmd.push("--clean", "--if-exists");

  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // proc.stdin is a Bun FileSink: write(chunk) + end() directly
  const stdin = proc.stdin as { write: (data: any) => number; end: () => void };
  try {
    for await (const chunk of input as any) {
      stdin.write(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
    }
    stdin.end();
  } catch (e: any) {
    return { ok: false, error: `input pipe error: ${e.message}` };
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    return { ok: false, error: `pg_restore exit ${exitCode}: ${stderr.trim() || "(no stderr)"}` };
  }
  return { ok: true };
}

/** Test the credentials work by running pg_isready inside the target container. */
export async function pingDatabase(
  database: Database_,
): Promise<{ ok: boolean; error?: string }> {
  // First confirm the container exists at all
  const inspect = Bun.spawn(
    ["docker", "inspect", "--format", "{{.State.Running}}", database.container_name],
    { stdout: "pipe", stderr: "pipe" },
  );
  const inspectOut = (await new Response(inspect.stdout).text()).trim();
  if ((await inspect.exited) !== 0) {
    return { ok: false, error: `container '${database.container_name}' not found` };
  }
  if (inspectOut !== "true") {
    return { ok: false, error: `container '${database.container_name}' is not running` };
  }

  const proc = Bun.spawn(
    [
      "docker",
      "exec",
      "--env",
      `PGPASSWORD=${database.pg_password}`,
      database.container_name,
      "pg_isready",
      "-U",
      database.pg_user,
      "-d",
      database.pg_database,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = (await new Response(proc.stderr).text()).trim();
    return { ok: false, error: `pg_isready exit ${code}: ${stderr || "(no stderr)"}` };
  }
  return { ok: true };
}

/** Discover candidate Postgres containers via label filter. */
export async function discoverCandidates(): Promise<
  { name: string; image: string; labels: Record<string, string> }[]
> {
  const proc = Bun.spawn(
    [
      "docker",
      "ps",
      "--filter",
      "label=hosting.backup.enabled=true",
      "--format",
      "{{.Names}}\t{{.Image}}\t{{.Labels}}",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;

  const candidates: { name: string; image: string; labels: Record<string, string> }[] = [];
  for (const line of out.trim().split("\n").filter(Boolean)) {
    const [name, image, labelsStr] = line.split("\t");
    const labels: Record<string, string> = {};
    for (const kv of (labelsStr ?? "").split(",")) {
      const eq = kv.indexOf("=");
      if (eq > 0) labels[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
    }
    candidates.push({ name: name ?? "", image: image ?? "", labels });
  }
  return candidates;
}
