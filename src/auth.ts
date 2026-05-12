// Cloudflare Access JWT verification middleware.
//
// When CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD_TAG are set, every request must
// carry a valid Cf-Access-Jwt-Assertion signed by Cloudflare. This prevents
// bypassing CF Access via direct origin-IP access (e.g. if cloudflared is
// briefly misconfigured).
//
// When either env is unset, the app trusts that CF Access is in front and skips
// verification. Acceptable for local dev or when behind a verified tunnel.

import type { MiddlewareHandler } from "hono";

const TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN ?? "";
const AUD_TAG = process.env.CF_ACCESS_AUD_TAG ?? "";

const verifyEnabled = TEAM_DOMAIN !== "" && AUD_TAG !== "";

let cachedKeys: Map<string, CryptoKey> | null = null;
let cachedAt = 0;
const KEY_TTL_MS = 60 * 60 * 1000; // refresh JWKS once per hour

async function fetchKeys(): Promise<Map<string, CryptoKey>> {
  const url = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
  const json = (await resp.json()) as { keys: any[] };
  const out = new Map<string, CryptoKey>();
  for (const jwk of json.keys ?? []) {
    if (jwk.kty !== "RSA" || jwk.alg !== "RS256") continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    out.set(jwk.kid, key);
  }
  return out;
}

async function getKeys(): Promise<Map<string, CryptoKey>> {
  if (cachedKeys && Date.now() - cachedAt < KEY_TTL_MS) return cachedKeys;
  cachedKeys = await fetchKeys();
  cachedAt = Date.now();
  return cachedKeys;
}

function decodeBase64Url(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function verifyJwt(token: string): Promise<{
  ok: boolean;
  reason?: string;
  email?: string;
}> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed JWT" };
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(payloadB64)));
  const sig = decodeBase64Url(sigB64);
  const signedBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const keys = await getKeys();
  const key = keys.get(header.kid);
  if (!key) return { ok: false, reason: `unknown kid ${header.kid}` };

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sig,
    signedBytes,
  );
  if (!valid) return { ok: false, reason: "bad signature" };

  // Check aud claim
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(AUD_TAG)) {
    return { ok: false, reason: `aud mismatch (expected ${AUD_TAG})` };
  }

  // Check expiry
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, email: payload.email };
}

export const cfAccessMiddleware: MiddlewareHandler = async (c, next) => {
  // Skip the health check
  if (c.req.path === "/healthz") return next();

  if (!verifyEnabled) {
    // Trust CF Access in front. Continue.
    return next();
  }

  const token =
    c.req.header("Cf-Access-Jwt-Assertion") ??
    c.req.header("cf-access-jwt-assertion") ??
    "";
  if (!token) {
    return c.text("Forbidden: missing Cf-Access-Jwt-Assertion header", 403);
  }

  try {
    const result = await verifyJwt(token);
    if (!result.ok) {
      return c.text(`Forbidden: ${result.reason}`, 403);
    }
    c.set("userEmail", result.email ?? "");
  } catch (e: any) {
    return c.text(`Auth error: ${e.message}`, 500);
  }
  return next();
};
