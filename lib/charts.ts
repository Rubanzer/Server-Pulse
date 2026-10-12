// Metric catalogue + derivation from raw Netdata dimensions. Pure; shared by live, history, sync and demo.

export const METRICS = ["cpu", "ram", "load", "io", "net", "disk", "temp"] as const;
export type Metric = (typeof METRICS)[number];
export type Dims = Record<string, number>;

type Def = {
  label: string;
  /** Netdata chart ids, first that exists wins. `temp` is discovered by context instead. */
  ids: string[];
  /** Series shown on charts, in order, with units. */
  series: { key: string; label: string; unit: string }[];
};

export const DEFS: Record<Metric, Def> = {
  cpu: { label: "CPU", ids: ["system.cpu"], series: [{ key: "cpu", label: "CPU", unit: "%" }] },
  ram: {
    label: "RAM",
    ids: ["system.ram"],
    series: [
      { key: "pct", label: "Used", unit: "%" },
      { key: "usedGiB", label: "Used", unit: "GiB" },
    ],
  },
  load: {
    label: "Load",
    ids: ["system.load"],
    series: [
      { key: "load1", label: "1 min", unit: "" },
      { key: "load5", label: "5 min", unit: "" },
      { key: "load15", label: "15 min", unit: "" },
    ],
  },
  io: {
    label: "Disk I/O",
    ids: ["system.io"],
    series: [
      { key: "read", label: "Read", unit: "KiB/s" },
      { key: "write", label: "Write", unit: "KiB/s" },
    ],
  },
  net: {
    label: "Network",
    ids: ["system.net"],
    series: [
      { key: "in", label: "In", unit: "kbit/s" },
      { key: "out", label: "Out", unit: "kbit/s" },
    ],
  },
  disk: {
    label: "Disk /",
    ids: ["disk_space./", "disk_space._"],
    series: [
      { key: "pct", label: "Used", unit: "%" },
      { key: "usedGiB", label: "Used", unit: "GiB" },
    ],
  },
  temp: { label: "Temperature", ids: [], series: [{ key: "max", label: "Hottest", unit: "°C" }] },
};

/** Netdata temperature contexts differ between collector versions (sensors.temperature, sensors.chip_temperature, …). */
export const isTempContext = (ctx: string | undefined) => !!ctx && /^sensors\..*temp/.test(ctx);

export function isMetric(x: unknown): x is Metric {
  return typeof x === "string" && (METRICS as readonly string[]).includes(x);
}

const sum = (d: Dims) => Object.values(d).reduce((a, b) => a + b, 0);
const pick = (d: Dims, ...keys: string[]) => {
  for (const k of keys) if (d[k] !== undefined) return d[k];
  return undefined;
};
const round = (v: number, p = 2) => Math.round(v * 10 ** p) / 10 ** p;

/**
 * Raw Netdata dimensions → display values. Dimension ids and names both work
 * (allmetrics keys by id, /data labels by name; they differ for system.io).
 */
export function derive(metric: Metric, d: Dims): Dims {
  switch (metric) {
    case "cpu":
      return { cpu: round(sum(d)) };
    case "ram": {
      const used = d.used ?? 0;
      const total = sum(d);
      return { pct: total ? round((100 * used) / total) : 0, usedGiB: round(used / 1024) };
    }
    case "load":
      return { load1: d.load1 ?? 0, load5: d.load5 ?? 0, load15: d.load15 ?? 0 };
    case "io":
      return { read: round(Math.abs(pick(d, "in", "reads") ?? 0)), write: round(Math.abs(pick(d, "out", "writes") ?? 0)) };
    case "net":
      return { in: round(Math.abs(d.received ?? 0)), out: round(Math.abs(d.sent ?? 0)) };
    case "disk": {
      const used = d.used ?? 0;
      const avail = d.avail ?? 0;
      return { pct: used + avail ? round((100 * used) / (used + avail)) : 0, usedGiB: round(used) };
    }
    case "temp": {
      const vals = Object.values(d);
      return { max: vals.length ? round(Math.max(...vals)) : 0 };
    }
  }
}

/** The single headline number for a KPI card / sparkline. */
export function headline(metric: Metric, v: Dims): number {
  switch (metric) {
    case "cpu":
      return v.cpu ?? 0;
    case "ram":
    case "disk":
      return v.pct ?? 0;
    case "load":
      return v.load1 ?? 0;
    case "io":
      return (v.read ?? 0) + (v.write ?? 0);
    case "net":
      return (v.in ?? 0) + (v.out ?? 0);
    case "temp":
      return v.max ?? 0;
  }
}

export type Point = { t: number; v: Dims }; // t = unix seconds
