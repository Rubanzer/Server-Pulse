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
    top: { pid: number; name: string; user: string; cpu: number; mem: number; thr: number; cmd?: string }[];
    groups: { name: string; n: number; cpu: number; mem: number }[];
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

/** Stream tokens: v1.<exp>.<nonce>.<sig>; must match agent/stream.go (verifyToken). */
export const STREAM_KEY_LABEL = "server-pulse stream v1";
