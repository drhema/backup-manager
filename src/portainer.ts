// Portainer API client — minimal port of dublyo-api/internal/services/portainer.go.
// Used by the provision flow to create new Postgres stacks via the same API
// the user already runs sites on.

const PORTAINER_URL = process.env.PORTAINER_URL ?? "http://portainer:9000";
const PORTAINER_API_KEY = process.env.PORTAINER_API_KEY ?? "";
const PORTAINER_ENDPOINT_ID = Number(process.env.PORTAINER_ENDPOINT_ID ?? 3);

export function portainerConfigured(): boolean {
  return PORTAINER_API_KEY !== "" && PORTAINER_URL !== "";
}

export function endpointId(): number {
  return PORTAINER_ENDPOINT_ID;
}

type StackEnvVar = { name: string; value: string };

export type PortainerStack = {
  Id: number;
  Name: string;
  Type: number;
  EndpointId: number;
  Status: number;
};

async function portainerFetch<T = any>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const r = await fetch(PORTAINER_URL + path, {
    ...init,
    headers: {
      "X-API-Key": PORTAINER_API_KEY,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Portainer API error (HTTP ${r.status}): ${body.slice(0, 300)}`);
  }
  if (r.status === 204) return undefined as any;
  return (await r.json()) as T;
}

export async function deployStack(
  name: string,
  composeContent: string,
  env: Record<string, string>,
): Promise<PortainerStack> {
  const envVars: StackEnvVar[] = Object.entries(env).map(([k, v]) => ({ name: k, value: v }));
  return await portainerFetch<PortainerStack>(
    `/api/stacks/create/standalone/string?endpointId=${PORTAINER_ENDPOINT_ID}`,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        stackFileContent: composeContent,
        env: envVars,
        fromAppTemplate: false,
      }),
    },
  );
}

export async function deleteStack(stackId: number): Promise<void> {
  await portainerFetch(`/api/stacks/${stackId}?endpointId=${PORTAINER_ENDPOINT_ID}`, {
    method: "DELETE",
  });
}

export async function listStacks(): Promise<PortainerStack[]> {
  return await portainerFetch<PortainerStack[]>(
    `/api/stacks?filters=${encodeURIComponent(JSON.stringify({ EndpointID: PORTAINER_ENDPOINT_ID }))}`,
  );
}

/** Find next free host port within [start, end] by inspecting running containers. */
export async function nextFreePort(start: number, end: number): Promise<number> {
  // Query Portainer for all containers, look at PublicPort bindings on the host
  const containers = await portainerFetch<any[]>(
    `/api/endpoints/${PORTAINER_ENDPOINT_ID}/docker/containers/json?all=true`,
  );
  const used = new Set<number>();
  for (const c of containers ?? []) {
    for (const p of c.Ports ?? []) {
      if (typeof p.PublicPort === "number") used.add(p.PublicPort);
    }
  }
  for (let p = start; p <= end; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error(`No free port in range ${start}-${end}`);
}

/** Wait for a container to reach 'running' state (best-effort). */
export async function waitForContainer(
  containerName: string,
  timeoutMs = 60_000,
): Promise<{ running: boolean; details?: any }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await portainerFetch<any[]>(
        `/api/endpoints/${PORTAINER_ENDPOINT_ID}/docker/containers/json?all=true`,
      );
      const c = list.find((x) =>
        (x.Names ?? []).some((n: string) => n === `/${containerName}` || n.endsWith(`/${containerName}`)),
      );
      if (c && c.State === "running") {
        return { running: true, details: c };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { running: false };
}
