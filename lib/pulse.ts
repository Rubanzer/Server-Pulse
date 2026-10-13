// Live "btop" frame shared by the agent stream, the server-side fallback and the Server page.
// Mirrors agent/pulse.go (Frame). Pure: safe to import from client components.

export type PulseFrame = {
  boot: string;
  seq: number;
  t: number;
  up: number;
  load: [number, number, number];
  cpu: { model?: string; total: number; cores: number[]; temps?: number[]; pkg?: number; mhz?: number[]; physical?: number };
  mem: { total: number; used: number; avail: number; cached: number; free: number; swapTotal: number; swapUsed: number };
  disks?: { path: string; fs: string; dev: string; size: number; used: number; avail: number }[];
  io: { dev: string; r: number; w: number }[];
  net: { name: string; in: number; out: number; rxT: number; txT: number }[];
  procs?: {
    count: number;
    /** st: R running, S sleeping, D waiting on disk, Z defunct…; born: unix start time; file: the script an interpreter runs */
    top: { pid: number; name: string; user: string; cpu: number; mem: number; thr: number; st?: string; born?: number; file?: string; cmd?: string }[];
    groups: { name: string; n: number; cpu: number; mem: number; ps?: { pid: number; name: string; user: string; cpu: number; mem: number; thr: number; st?: string; born?: number; file?: string; cmd?: string }[] }[];
    hidden?: boolean;
  };
};

/** Delta frames omit slow-changing parts (disks, model, MHz, processes); keep the last known values. */
export function mergeFrame(prev: PulseFrame | null, next: PulseFrame): PulseFrame {
  if (!prev || prev.boot !== next.boot) return next; // server rebooted: start over
  return {
    ...next,
    cpu: {
      ...next.cpu,
      model: next.cpu.model ?? prev.cpu.model,
      physical: next.cpu.physical ?? prev.cpu.physical,
      mhz: next.cpu.mhz ?? prev.cpu.mhz,
    },
    disks: next.disks ?? prev.disks,
    procs: next.procs ?? prev.procs,
  };
}

/** A pulse frame as Live-page readings (same keys and units as derive() on Netdata charts). */
export function frameValues(f: PulseFrame): Record<string, Record<string, number>> {
  const root = f.disks?.find((d) => d.path === "/") ?? f.disks?.[0];
  const temps = [...(f.cpu.temps ?? []), f.cpu.pkg ?? 0].filter((x) => x > 0);
  const out: Record<string, Record<string, number>> = {
    cpu: { cpu: f.cpu.total },
    ram: { pct: f.mem.total ? Math.round((1000 * f.mem.used) / f.mem.total) / 10 : 0, usedGiB: Math.round((100 * f.mem.used) / 1024) / 100 },
    load: { load1: f.load[0], load5: f.load[1], load15: f.load[2] },
    io: { read: f.io.reduce((a, d) => a + d.r, 0), write: f.io.reduce((a, d) => a + d.w, 0) },
    net: { in: f.net.reduce((a, n) => a + n.in, 0), out: f.net.reduce((a, n) => a + n.out, 0) },
  };
  if (root) out.disk = { pct: root.size ? Math.round((1000 * root.used) / root.size) / 10 : 0, usedGiB: Math.round((100 * root.used) / 1024) / 100 };
  if (temps.length) out.temp = { max: Math.max(...temps) };
  return out;
}

/** Stream tokens: v1.<exp>.<nonce>.<sig>; must match agent/stream.go (verifyToken). */
export const STREAM_KEY_LABEL = "server-pulse stream v1";
