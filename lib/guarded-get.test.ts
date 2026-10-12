import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { isPrivateAddress } from "./crypto.ts";
import { guardedGet } from "./guarded-get.ts";

// local plain-http server; the address filter is relaxed so tests can reach 127.0.0.1
function serve(handler: Parameters<typeof createServer>[1]) {
  return new Promise<{ url: string; close: () => void }>((ok) => {
    const s = createServer(handler).listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      ok({ url: `http://localhost:${port}/`, close: () => {
        s.closeAllConnections();
        s.close();
      } });
    });
  });
}
const open = { timeoutMs: 1000, maxBytes: 1024, isPrivate: () => false, request };

test("normal response", async () => {
  const s = await serve((_q, r) => r.end('{"ok":1}'));
  assert.deepEqual(await guardedGet(s.url, {}, open), { status: 200, text: '{"ok":1}' });
  s.close();
});

test("a server trickling bytes hits the hard deadline", async () => {
  const s = await serve((_q, r) => {
    r.writeHead(200);
    const t = setInterval(() => r.write("x"), 100); // never ends, never idle long
    r.on("close", () => clearInterval(t));
  });
  const started = Date.now();
  await assert.rejects(guardedGet(s.url, {}, { ...open, timeoutMs: 500 }), { code: "ETIMEDOUT" });
  assert.ok(Date.now() - started < 1500);
  s.close();
});

test("a server that never answers hits the deadline", async () => {
  const s = await serve(() => {});
  await assert.rejects(guardedGet(s.url, {}, { ...open, timeoutMs: 300 }), { code: "ETIMEDOUT" });
  s.close();
});

test("oversized bodies are cut off", async () => {
  const s = await serve((_q, r) => r.end("y".repeat(5000)));
  await assert.rejects(guardedGet(s.url, {}, open), { code: "ETOOBIG" });
  s.close();
});

test("redirects are not followed", async () => {
  const s = await serve((_q, r) => {
    r.writeHead(302, { location: "http://169.254.169.254/" });
    r.end();
  });
  assert.equal((await guardedGet(s.url, {}, open)).status, 302);
  s.close();
});

test("private addresses are refused, by DNS name and by literal", async () => {
  const strict = { ...open, isPrivate: isPrivateAddress };
  await assert.rejects(guardedGet("http://localhost:9/", {}, strict), { code: "EPRIVATE" });
  await assert.rejects(guardedGet("http://127.0.0.1:9/", {}, strict), { code: "EPRIVATE" });
  await assert.rejects(guardedGet("http://[::1]:9/", {}, strict), { code: "EPRIVATE" });
});
