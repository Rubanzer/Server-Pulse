// Password hashing, secret encryption and private-address checks. node:crypto / node:net only, no "@/" imports
// (so `node --test` runs it directly).
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";

// ---------- passwords: scrypt (memory-hard), self-describing format ----------

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = scryptSync(pw.normalize("NFKC"), Buffer.from(salt, "base64url"), want.length, { N: +n!, r: +r!, p: +p! });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Hash to compare against when the account doesn't exist, so "no such user" and "wrong password" take the same time. */
export const DUMMY_HASH = hashPassword("server-pulse-dummy-password");

// ---------- secrets at rest: AES-256-GCM ----------

const keyOf = (secret: string) => createHash("sha256").update("server-pulse:link-key:" + secret).digest();

export function encrypt(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

/** null when the ciphertext was tampered with or the secret changed. */
export function decrypt(token: string, secret: string): string | null {
  const [v, iv, tag, body] = token.split(".");
  if (v !== "v1" || !iv || !tag || !body) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", keyOf(secret), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------- SSRF guard: addresses an account-supplied link must never reach ----------

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT, includes tailnet-internal 100.x addresses
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3], // multicast + reserved
] as const)
  blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, bits, "ipv6");

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return blocked.check(ip, "ipv4");
  if (v === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
    return mapped ? blocked.check(mapped, "ipv4") : blocked.check(ip, "ipv6");
  }
  return true; // not an IP at all → refuse
}
