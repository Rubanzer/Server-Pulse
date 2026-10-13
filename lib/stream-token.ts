import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { STREAM_KEY_LABEL } from "@/lib/pulse";

/**
 * Short-lived, single-use token that lets a browser stream straight from the agent. Signed with a key
 * derived from the server link's password (which never leaves the dashboard). Must match
 * agent/stream.go verifyToken: "v1.<exp>.<nonce>.<sig>" for the live view (older agents understand it),
 * "v2.<scope>.<exp>.<nonce>.<sig>" for scoped streams such as logs.
 */
export function mintStreamToken(password: string, scope: "pulse" | "logs", ttlSec = 60): string {
  const key = createHmac("sha256", password).update(STREAM_KEY_LABEL).digest();
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const nonce = randomBytes(12).toString("base64url");
  const signed = scope === "pulse" ? `v1.${exp}.${nonce}` : `v2.${scope}.${exp}.${nonce}`;
  return `${signed}.${createHmac("sha256", key).update(signed).digest("base64url")}`;
}
