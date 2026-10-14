// HTTP GET for untrusted hosts. node:* only, no "@/" imports (so `node --test` runs it directly).
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

type Opts = {
  timeoutMs: number;
  maxBytes: number;
  /** Address filter; returning true refuses the connection. */
  isPrivate: (ip: string) => boolean;
  /** Injected in tests (plain http); https in production. */
  request?: (url: string, o: RequestOptions, cb: (res: IncomingMessage) => void) => ClientRequest;
};

const fail = (code: string, name = "Error") => Object.assign(new Error(code), { code, name });

/**
 * - The address check runs inside the socket's own DNS lookup, so the checked IP is the IP connected to
 *   (no DNS-rebinding window). IP literals skip DNS and are checked up front (IPv6 comes bracketed).
 * - Redirects are never followed (Node's request doesn't), bodies are capped, and one hard deadline
 *   covers DNS + connect + the whole body, so a server trickling bytes can't hold the caller open.
 * - The promise settles exactly once, whatever order the socket events arrive in.
 */
export function guardedGet(url: string, headers: Record<string, string>, o: Opts): Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    let done = false;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      fn();
    };

    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && o.isPrivate(host)) return reject(fail("EPRIVATE"));

    const lookup: LookupFunction = (hostname, options, cb) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err, "", 4);
        const list = addrs as LookupAddress[];
        if (!list.length || list.some((a) => o.isPrivate(a.address))) return cb(fail("EPRIVATE"), "", 4);
        if (options.all) return (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
        cb(null, list[0]!.address, list[0]!.family);
      });
    };

    const req = (o.request ?? httpsRequest)(url, { method: "GET", headers, lookup }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > o.maxBytes) {
          settle(() => reject(fail("ETOOBIG")));
          req.destroy();
        } else chunks.push(c);
      });
      res.on("end", () => settle(() => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers })));
      res.on("error", (e) => settle(() => reject(e)));
      res.on("close", () => settle(() => reject(fail("ECONNRESET"))));
    });
    const deadline = setTimeout(() => {
      settle(() => reject(fail("ETIMEDOUT", "TimeoutError")));
      req.destroy();
    }, o.timeoutMs);
    req.on("error", (e) => settle(() => reject(e)));
    req.end();
  });
}

/**
 * A connection that failed before any answer, in plain words with the one thing to check for the tunnel
 * in use. The raw code stays at the end for searching.
 */
export function unreachable(host: string, code: string): string {
  const cut = /ECONNRESET|EPIPE|ECONNABORTED|EPROTO|ERR_SSL|socket hang up|disconnected before secure TLS/i.test(code);
  const funnel = /\.ts\.net(:\d+)?$/i.test(host);
  const ngrok = /\.ngrok/i.test(host);
  let why: string;
  if (cut && funnel)
    why = `Tailscale Funnel isn't passing connections to your server (it cut the connection before your server answered). On the server, "tailscale funnel status" should show ${host} (Funnel on) → 127.0.0.1:19998, and "sudo server-pulse-agent status" checks the whole path.`;
  else if (cut && ngrok) why = `ngrok cut the connection before your server answered. On the server, ngrok must be running and pointing at 127.0.0.1:19998.`;
  else if (cut) why = `the connection to ${host} was cut before your server answered: the tunnel or proxy isn't forwarding to 127.0.0.1:19998.`;
  else if (/ENOTFOUND|EAI_AGAIN/i.test(code)) why = `${host} doesn't exist in public DNS. Check the address, or run the Add server command again.`;
  else if (/ECONNREFUSED/i.test(code)) why = `nothing accepts connections at ${host}.`;
  else if (/ENETUNREACH|EHOSTUNREACH/i.test(code)) why = `${host} can't be reached from the internet right now.`;
  else return `Cannot reach ${host}: ${code}`;
  return `Cannot reach ${host}: ${why} (${code})`;
}
