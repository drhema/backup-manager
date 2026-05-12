// AES-256-GCM encryption for at-rest secrets (DB passwords, S3 secret keys).
// Key comes from ENCRYPTION_KEY env (32 bytes hex = 64 chars).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_HEX = process.env.ENCRYPTION_KEY ?? "";
if (KEY_HEX.length !== 64) {
  throw new Error(
    "ENCRYPTION_KEY must be set to 32 bytes hex (64 chars). " +
      "Generate with: openssl rand -hex 32",
  );
}
const KEY = Buffer.from(KEY_HEX, "hex");

export function encrypt(plain: string): string {
  if (plain === "") return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store as iv:tag:ciphertext (all base64). Single column friendly.
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decrypt(stored: string): string {
  if (stored === "") return "";
  const [ivB64, tagB64, encB64] = stored.split(":");
  if (!ivB64 || !tagB64 || !encB64) {
    throw new Error("Encrypted value is malformed");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const enc = Buffer.from(encB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}
