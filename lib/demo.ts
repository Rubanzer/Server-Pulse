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

/** A believable 32-core / 64-thread box for the Server page in demo mode. */
export function demoPulse(t = Math.floor(Date.now() / 1000)): import("@/lib/pulse").PulseFrame {
  const n = 64;
  const base = derive("cpu", demoRaw("cpu", t)).cpu ?? 20;
  const cores = Array.from({ length: n }, (_, i) => Math.max(0, Math.min(100, Math.round(base * (0.4 + hash01(i * 7919 + Math.floor(t / 2)) * 1.4) + (i % 9 === 0 ? 30 : 0)))));
  const temps = cores.map((c, i) => Math.round(36 + cores[i % 32]! * 0.3 + (i % 32) * 0.1));
  const ram = demoRaw("ram", t);
  const proc = (pid: number, name: string, user: string, cpu: number, mem: number, thr: number) => ({ pid, name, user, cpu, mem, thr });
  return {
    boot: "demo",
    seq: t,
    t,
    up: 12 * 86400 + (t % 86400),
    load: [round2(base / 20), round2(base / 22), round2(base / 25)],
    cpu: { model: "Intel(R) Xeon(R) Gold 6530", total: Math.round(cores.reduce((a, b) => a + b, 0) / n), cores, temps, pkg: Math.max(...temps) + 3, mhz: cores.map((c) => 800 + c * 30), physical: 32 },
    mem: { total: 63_900, used: Math.round(ram.used! * 3.4), avail: 63_900 - Math.round(ram.used! * 3.4), cached: 24_300, free: 26_900, swapTotal: 8_190, swapUsed: 0 },
    disks: [
      { path: "/data", fs: "ext4", dev: "nvme1n1", size: 11_300_000, used: 590_000, avail: 10_700_000 },
      { path: "/", fs: "ext4", dev: "nvme0n1p2", size: 2_990_000, used: 278_000, avail: 2_720_000 },
      { path: "/boot/efi", fs: "vfat", dev: "nvme0n1p1", size: 1_070, used: 6, avail: 1_064 },
    ],
    io: [{ dev: "nvme0n1", r: Math.round(base * 40), w: Math.round(base * 90) }, { dev: "nvme1n1", r: Math.round(base * 10), w: Math.round(base * 20) }],
    net: [{ name: "eno1", in: Math.round(15_000 * (0.5 + hash01(t))), out: Math.round(15_000 * (0.5 + hash01(t + 1))), rxT: 46_300, txT: 46_200 }],
    procs: {
      count: 908,
      top: [
        proc(254142, "python3", "antpc", round1(base * 0.08), 522, 72),
        proc(257506, "python", "antpc", round1(base * 0.07), 136, 65),
        proc(2677, "python", "antpc", round1(base * 0.05), 37, 18),
        proc(3007, "postgres", "postgres", 0.4, 142, 1),
        proc(5920, "Xorg", "antpc", 0.3, 424, 2),
        proc(6955, "gnome-shell", "antpc", 0.2, 603, 81),
        proc(2676, "netdata", "netdata", 0.1, 202, 499),
        proc(3219, "grafana", "grafana", 0.1, 263, 51),
      ],
      groups: [
        { name: "python3", n: 6, cpu: round1(base * 0.1), mem: 1_560 },
        { name: "chrome", n: 140, cpu: 1.2, mem: 9_800 },
        { name: "postgres", n: 31, cpu: 0.6, mem: 3_900 },
        { name: "firefox", n: 22, cpu: 0.4, mem: 4_200 },
        { name: "netdata", n: 3, cpu: 0.2, mem: 380 },
      ],
    },
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
