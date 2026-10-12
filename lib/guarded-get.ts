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
export function guardedGet(url: string, headers: Record<string, string>, o: Opts): Promise<{ status: number; text: string }> {
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
      res.on("end", () => settle(() => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") })));
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
