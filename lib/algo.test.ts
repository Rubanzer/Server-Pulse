import { test } from "node:test";
import assert from "node:assert/strict";
import { RingBuffer, quantile, stats, cached, chunk, bucketStep, mergeMax, WindowLimiter } from "./algo.ts";
import { derive } from "./charts.ts";
import { parseServerLink, detectTunnel, maskLink } from "./config.ts";

test("RingBuffer keeps the newest N in order", () => {
  const r = new RingBuffer<number>(3);
  assert.deepEqual(r.toArray(), []);
  [1, 2, 3, 4, 5].forEach((x) => r.push(x));
  assert.deepEqual(r.toArray(), [3, 4, 5]);
  assert.equal(r.last(), 5);
  assert.equal(r.size, 3);
});

test("quantile matches a sort-based nearest-rank on random input", () => {
  for (let n = 1; n < 200; n += 7) {
    const a = Array.from({ length: n }, () => Math.round(Math.random() * 50));
    const sorted = [...a].sort((x, y) => x - y);
    for (const q of [0, 0.5, 0.95, 1]) {
      const k = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
      assert.equal(quantile(a, q), sorted[k]);
    }
  }
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([NaN, 4], 0.5), 4);
});

test("stats one-pass", () => {
  const s = stats([1, 2, 3, 4, NaN])!;
  assert.equal(s.avg, 2.5);
  assert.equal(s.peak, 4);
  assert.equal(s.min, 1);
  assert.equal(s.count, 4);
  assert.equal(stats([]), null);
});

test("cached shares in-flight calls and expires", async () => {
  let calls = 0;
  let t = 0;
  const get = cached(async () => ++calls, () => 100, () => t);
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(await get(), 1);
  t = 150;
  assert.equal(await get(), 2);
});

test("cached does not cache failures", async () => {
  let n = 0;
  const get = cached(async () => {
    if (++n === 1) throw new Error("x");
    return n;
  }, () => 1000);
  await assert.rejects(get());
  assert.equal(await get(), 2);
});

test("chunk / bucketStep / mergeMax", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(bucketStep(3600), 60);
  assert.equal(bucketStep(365 * 86400), 63072);
  assert.deepEqual(
    mergeMax([
      [[1, 10], [2, 5]],
      [[2, 9], [3, 1]],
    ]),
    [[1, 10], [2, 9], [3, 1]],
  );
});

test("WindowLimiter", () => {
  let t = 0;
  const l = new WindowLimiter(2, 1000, () => t);
  assert.ok(l.hit("a"));
  assert.ok(l.hit("a"));
  assert.ok(!l.hit("a"));
  assert.ok(l.hit("b"));
  t = 1001;
  assert.ok(l.hit("a"));
});

test("derive", () => {
  assert.deepEqual(derive("cpu", { user: 3.1, system: 1.2 }), { cpu: 4.3 });
  assert.deepEqual(derive("ram", { used: 2048, free: 1024, cached: 1024 }), { pct: 50, usedGiB: 2 });
  assert.deepEqual(derive("net", { received: 100, sent: -50 }), { in: 100, out: 50 });
  assert.deepEqual(derive("io", { reads: 10, writes: -20 }), { read: 10, write: 20 });
  assert.deepEqual(derive("disk", { used: 30, avail: 70, reserved_for_root: 5 }), { pct: 30, usedGiB: 30 });
  assert.deepEqual(derive("temp", { a: 40, b: 61.5 }), { max: 61.5 });
});

test("parseServerLink", () => {
  const l = parseServerLink("https://dashboard:p%40ss@box.tail1.ts.net");
  assert.equal(l.base, "https://box.tail1.ts.net/history");
  assert.equal(l.pass, "p@ss");
  assert.equal(l.tunnel, "funnel");
  assert.equal(parseServerLink("https://u:p@x.ngrok-free.app/history/").base, "https://x.ngrok-free.app/history");
  assert.equal(detectTunnel("x.ngrok-free.app"), "ngrok");
  assert.equal(detectTunnel("example.com"), "other");
  assert.ok(!maskLink(l).includes("p@ss"));
  assert.throws(() => parseServerLink("https://host.ts.net"), /USER:PASS/);
  assert.throws(() => parseServerLink("nope"), /valid URL/);
});

import { monotonePath, nearestIndex, niceCeil, Lru } from "./algo.ts";

test("monotonePath never overshoots the data range", () => {
  const xs = [0, 1, 2, 3, 4, 5];
  const ys = [0, 0, 10, 10, 0, 0];
  const p = monotonePath(xs, ys);
  assert.ok(p.startsWith("M0,0"));
  // every control-point y stays within [min, max] of the data
  const nums = p.replace(/[MC]/g, " ").trim().split(/[\s,]+/).map(Number);
  for (let i = 1; i < nums.length; i += 2) assert.ok(nums[i]! >= 0 && nums[i]! <= 10, `y=${nums[i]}`);
  assert.equal(monotonePath([], []), "");
  assert.equal(monotonePath([1], [2]), "M1,2");
});

test("nearestIndex", () => {
  const a = [10, 20, 30, 40];
  assert.equal(nearestIndex(a, 0), 0);
  assert.equal(nearestIndex(a, 24), 1);
  assert.equal(nearestIndex(a, 26), 2);
  assert.equal(nearestIndex(a, 99), 3);
  assert.equal(nearestIndex([], 5), -1);
});

test("niceCeil", () => {
  assert.equal(niceCeil(0), 1);
  assert.equal(niceCeil(7), 10);
  assert.equal(niceCeil(1.6), 2);
  assert.equal(niceCeil(230), 250);
  assert.equal(niceCeil(1800), 2000);
});

test("Lru evicts the least recently used", () => {
  const c = new Lru<string, number>(2);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a");
  c.set("c", 3);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("c"), 3);
});

import { composeLink, explainPaste } from "./paste-guard.ts";

test("explainPaste recognizes common wrong pastes", () => {
  assert.match(explainPaste("tskey-auth-kH3dWCpXg221CNTRL-abc")!, /Tailscale auth key/);
  assert.match(explainPaste("https://login.tailscale.com/admin/invite/8KQKbt1d9Dff")!, /invite/);
  assert.match(explainPaste("https://bunch-numbly-accent.ngrok-free.dev btop")!, /btop/);
  assert.match(explainPaste("http://localhost:7681")!, /btop/);
  assert.equal(explainPaste("https://dashboard:pw@x.ts.net/history"), null);
});

test("composeLink builds a safe link from fields", () => {
  assert.equal(composeLink("https://x.ngrok-free.dev/", "dashboard", "p@ss:w/rd"), "https://dashboard:p%40ss%3Aw%2Frd@x.ngrok-free.dev/history");
  assert.equal(composeLink("old:creds@host.ts.net", "", "pw"), "https://dashboard:pw@host.ts.net/history");
});

test("findGaps finds leading, middle and trailing holes, nothing in dense data", async () => {
  const { findGaps } = await import("./algo.ts");
  const dense = Array.from({ length: 60 }, (_, i) => 1000 + i * 60);
  assert.deepEqual(findGaps(dense, 1000, 1000 + 59 * 60, () => 120), []);
  const holed = [...dense.slice(0, 10), ...dense.slice(40)];
  assert.deepEqual(findGaps(holed, 1000, 1000 + 59 * 60, () => 120), [{ from: 1000 + 9 * 60, to: 1000 + 40 * 60 }]);
  // asked for more than exists: the hole before the first and after the last point
  assert.deepEqual(findGaps([5000, 5060], 1000, 9000, () => 120), [
    { from: 1000, to: 5000 },
    { from: 5060, to: 9000 },
  ]);
});

test("gapReason: pending past the sync point, off after a reboot, agent when only it restarted", async () => {
  const { gapReason } = await import("./algo.ts");
  const g = { from: 1000, to: 5000 };
  assert.equal(gapReason(g, 3000, []), "pending");
  assert.equal(gapReason(g, 9000, [{ start: 5100, btime: 5050 }]), "off");
  assert.equal(gapReason(g, 9000, [{ start: 5100, btime: 100 }]), "agent");
  assert.equal(gapReason(g, 9000, [{ start: 200, btime: 100 }]), "nodata");
});

test("coverage is the share of the window outside gaps", async () => {
  const { coverage } = await import("./algo.ts");
  assert.equal(coverage(0, 100, []), 1);
  assert.equal(coverage(0, 100, [{ from: 0, to: 25 }, { from: 90, to: 200 }]), 0.65);
  assert.equal(coverage(10, 10, []), 0);
});
