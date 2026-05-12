// pg_dump and pg_restore via Docker exec into the target Postgres container.
// We talk to the Docker socket via dockerode — no docker CLI needed in the
// backup-manager image. The target container provides pg_dump/pg_restore.

import Docker from "dockerode";
import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import type { Database_ } from "./db.ts";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

export type DumpResult = {
  ok: boolean;
  bytes: number;
  sha256: string;
  error?: string;
};

/**
 * Stream pg_dump output from a target Postgres container to a writable stream.
 * Counts bytes and computes sha256 in transit. Returns when pg_dump exits.
 */
export async function streamDump(
  database: Database_,
  out: Writable,
): Promise<DumpResult> {
  const container = docker.getContainer(database.container_name);

  // Confirm container is running
  try {
    const info = await container.inspect();
    if (!info.State.Running) {
      return { ok: false, bytes: 0, sha256: "", error: "container not running" };
    }
  } catch (e: any) {
    return { ok: false, bytes: 0, sha256: "", error: `inspect failed: ${e.message}` };
  }

  // pg_dump command — custom format (-Fc), no owner/role baked in (-O), include
  // permissions, exclude logical replication slots that aren't restorable.
  const exec = await container.exec({
    Cmd: [
      "pg_dump",
      "-U",
      database.pg_user,
      "-d",
      database.pg_database,
      "-Fc",
      "-Z",
      "6", // gzip level 6 inside custom format
      "--no-owner",
      "--no-privileges",
    ],
    Env: [`PGPASSWORD=${database.pg_password}`],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = (await exec.start({ hijack: true, stdin: false })) as Readable;

  // Demultiplex: docker exec without TTY returns multiplexed stdout/stderr
  // (header-prefixed). Use modem.demuxStream.
  const stderrChunks: Buffer[] = [];
  const stderrSink: Writable = (await import("node:stream")).Writable
    ? new (await import("node:stream")).Writable({
        write(chunk: Buffer, _enc, cb) {
          stderrChunks.push(chunk);
          cb();
        },
      })
    : (null as any);

  let bytes = 0;
  const hash = createHash("sha256");

  const counting: Writable = (await import("node:stream")).Writable
    ? new (await import("node:stream")).Writable({
        write(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          hash.update(chunk);
          out.write(chunk, cb);
        },
        final(cb) {
          out.end();
          cb();
        },
      })
    : (null as any);

  return await new Promise<DumpResult>((resolve) => {
    let settled = false;
    const settle = (r: DumpResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    counting.on("error", (e) =>
      settle({ ok: false, bytes, sha256: "", error: `write error: ${e.message}` }),
    );
    out.on("error", (e) =>
      settle({ ok: false, bytes, sha256: "", error: `out error: ${e.message}` }),
    );

    docker.modem.demuxStream(stream, counting, stderrSink);

    stream.on("end", async () => {
      // Inspect exit code
      let code = -1;
      try {
        const info = await exec.inspect();
        code = info.ExitCode ?? -1;
      } catch {}
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        settle({
          ok: false,
          bytes,
          sha256: hash.digest("hex"),
          error: `pg_dump exit ${code}: ${stderr || "(no stderr)"}`,
        });
      } else {
        settle({ ok: true, bytes, sha256: hash.digest("hex") });
      }
    });

    stream.on("error", (e) =>
      settle({ ok: false, bytes, sha256: "", error: `stream error: ${e.message}` }),
    );
  });
}

/**
 * Stream pg_restore stdin from a readable into the target Postgres container.
 * cleanFirst=true uses --clean --if-exists (destructive).
 */
export async function streamRestore(
  database: Database_,
  input: Readable,
  cleanFirst = false,
): Promise<{ ok: boolean; error?: string }> {
  const container = docker.getContainer(database.container_name);

  try {
    const info = await container.inspect();
    if (!info.State.Running) {
      return { ok: false, error: "container not running" };
    }
  } catch (e: any) {
    return { ok: false, error: `inspect failed: ${e.message}` };
  }

  const cmd = [
    "pg_restore",
    "-U",
    database.pg_user,
    "-d",
    database.pg_database,
    "--no-owner",
    "--role",
    database.pg_user,
  ];
  if (cleanFirst) {
    cmd.push("--clean", "--if-exists");
  }

  const exec = await container.exec({
    Cmd: cmd,
    Env: [`PGPASSWORD=${database.pg_password}`],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = (await exec.start({ hijack: true, stdin: true })) as any;

  return await new Promise((resolve) => {
    let settled = false;
    const stderrChunks: Buffer[] = [];
    const settle = (r: { ok: boolean; error?: string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    const noopOut = new (require("node:stream").Writable)({
      write(_chunk: Buffer, _enc: any, cb: any) {
        cb();
      },
    });
    const stderrSink = new (require("node:stream").Writable)({
      write(chunk: Buffer, _enc: any, cb: any) {
        stderrChunks.push(chunk);
        cb();
      },
    });

    docker.modem.demuxStream(stream, noopOut, stderrSink);

    input.pipe(stream);
    input.on("end", () => stream.end());
    input.on("error", (e) => settle({ ok: false, error: `input error: ${e.message}` }));

    stream.on("end", async () => {
      let code = -1;
      try {
        const info = await exec.inspect();
        code = info.ExitCode ?? -1;
      } catch {}
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        settle({ ok: false, error: `pg_restore exit ${code}: ${stderr || "(no stderr)"}` });
      } else {
        settle({ ok: true });
      }
    });
  });
}

/** Test a database is reachable + credentials are correct. */
export async function pingDatabase(
  database: Database_,
): Promise<{ ok: boolean; error?: string }> {
  const container = docker.getContainer(database.container_name);
  try {
    const exec = await container.exec({
      Cmd: ["pg_isready", "-U", database.pg_user, "-d", database.pg_database],
      Env: [`PGPASSWORD=${database.pg_password}`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = (await exec.start({ hijack: true, stdin: false })) as Readable;
    await new Promise<void>((res) => stream.on("end", () => res()));
    const info = await exec.inspect();
    if (info.ExitCode !== 0) {
      return { ok: false, error: `pg_isready exit ${info.ExitCode}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/** Discover candidate Postgres containers via label filter. */
export async function discoverCandidates(): Promise<
  { name: string; image: string; labels: Record<string, string> }[]
> {
  const containers = await docker.listContainers({
    filters: { label: ["hosting.backup.enabled=true"] },
  });
  return containers.map((c) => ({
    name: c.Names[0]?.replace(/^\//, "") ?? "",
    image: c.Image,
    labels: c.Labels ?? {},
  }));
}
