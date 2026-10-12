// Deterministic demo data: the same timestamp always yields the same values, so charts, history
// and reports agree with each other and stay stable across refreshes.
import { hash01 } from "@/lib/algo";
import { derive, METRICS, type Dims, type Metric } from "@/lib/charts";
import type { RawPoint, ServerInfo, Snapshot } from "@/lib/netdata";

const DAY = 86400;
const wave = (t: number, period: number, phase = 0) => Math.sin((2 * Math.PI * t) / period + phase);
const noise = (t: number, salt: number) => hash01(Math.floor(t / 2) * 31 + salt) - 0.5;

export function demoRaw(metric: Metric, t: number): Dims {
  const busy = 0.5 + 0.35 * wave(t, DAY, -Math.PI / 2) + 0.1 * wave(t, 7 * DAY);
  const cpu = Math.max(1, 6 + 45 * busy + 12 * noise(t, 1) + (hash01(Math.floor(t / 600)) > 0.97 ? 35 : 0));
  switch (metric) {
    case "cpu":
      return { user: cpu * 0.7, system: cpu * 0.25, iowait: cpu * 0.05 };
    case "ram": {
      const used = 5200 + 3000 * busy + 300 * noise(t, 2);
      return { used, cached: 4100, buffers: 300, free: 16384 - used - 4400 };
    }
    case "load":
      return { load1: (cpu / 100) * 4 + noise(t, 3) * 0.3, load5: (cpu / 100) * 3.6, load15: (cpu / 100) * 3.2 };
    case "io":
      return { reads: Math.max(0, 300 * busy + 200 * noise(t, 4)), writes: -Math.max(0, 900 * busy + 300 * noise(t, 5)) };
    case "net":
      return { received: Math.max(0, 2400 * busy + 800 * noise(t, 6)), sent: -Math.max(0, 900 * busy + 300 * noise(t, 7)) };
    case "disk": {
      const used = 118 + ((t / DAY) % 365) * 0.05;
      return { used, avail: 465 - used, reserved_for_root: 24 };
    }
    case "temp":
      return { max: 38 + cpu * 0.35 + noise(t, 8) * 2 };
  }
}

export function demoSeries(metric: Metric, from: number, to: number, points: number): RawPoint[] {
  const step = Math.max(1, Math.ceil((to - from) / points));
  const out: RawPoint[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push({ t, d: demoRaw(metric, t) });
  return out;
}

export function demoSnapshot(t = Math.floor(Date.now() / 1000)): Snapshot {
  const values: Snapshot["values"] = {};
  for (const m of METRICS) values[m] = derive(m, demoRaw(m, t));
  return { t, uptimeSec: 12 * DAY + (t % DAY), values };
}

export const demoInfo: ServerInfo = { hostname: "demo-server", os: "Ubuntu 24.04 LTS", kernel: "6.8.0", cores: 4, ramGiB: 16, netdata: "demo" };
