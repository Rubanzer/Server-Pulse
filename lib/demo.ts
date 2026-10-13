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
      const used = 82_000 + 48_000 * busy + 3_000 * noise(t, 2); // MiB of a 251.5 GiB box
      return { used, cached: 64_000, buffers: 2_100, free: 257_536 - used - 66_100 };
    }
    case "load":
      return { load1: (cpu / 100) * 4 + noise(t, 3) * 0.3, load5: (cpu / 100) * 3.6, load15: (cpu / 100) * 3.2 };
    case "io":
      return { reads: Math.max(0, 300 * busy + 200 * noise(t, 4)), writes: -Math.max(0, 900 * busy + 300 * noise(t, 5)) };
    case "net":
      return { received: Math.max(0, 80_000 * busy + 8_000 * noise(t, 6)), sent: -Math.max(0, 30_000 * busy + 3_000 * noise(t, 7)) };
    case "disk": {
      const used = 6_870 + ((t / DAY) % 365) * 0.5; // GiB of a 7.3 TiB array
      return { used, avail: 7_475 - used, reserved_for_root: 24 };
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

// Demo values are deliberately worst-case (but real-world): long host, NIC and mount names, TiB totals,
// 128 threads. Layout checks run against demo mode, so anything that fits here fits a real server.
export const demoInfo: ServerInfo = { hostname: "ip-172-31-45-210.ap-south-1.compute.internal", os: "Ubuntu 24.04.1 LTS", kernel: "6.8.0-1015-aws", cores: 128, ramGiB: 251.5, netdata: "demo" };

/** A big 64-core / 128-thread box for the Server page in demo mode (see demoInfo). */
export function demoPulse(t = Math.floor(Date.now() / 1000)): import("@/lib/pulse").PulseFrame {
  const n = 128;
  const base = derive("cpu", demoRaw("cpu", t)).cpu ?? 20;
  const cores = Array.from({ length: n }, (_, i) => Math.max(0, Math.min(100, Math.round(base * (0.4 + hash01(i * 7919 + Math.floor(t / 2)) * 1.4) + (i % 9 === 0 ? 30 : 0)))));
  const temps = cores.map((c, i) => Math.round(36 + cores[i % 32]! * 0.3 + (i % 32) * 0.1));
  const ram = demoRaw("ram", t);
  const born = t - 9 * 86400;
  const proc = (pid: number, name: string, user: string, cpu: number, mem: number, thr: number, extra: { st?: string; file?: string; cmd?: string } = {}) => ({
    pid, name, user, cpu, mem, thr, born: born + (pid % 5000) * 60, ...extra,
  });
  const pyA = proc(254142, "python3", "antpc", round1(base * 0.08), 522, 72, { file: "ingest_pipeline_v2_with_long_name.py" });
  const pyB = proc(257506, "python3", "antpc", round1(base * 0.07), 136, 65, { file: "-m uvicorn" });
  const pyC = proc(2677, "python3", "1000042", round1(base * 0.05), 37, 18, { file: "resize_images.py", st: "D" });
  return {
    boot: "demo",
    seq: t,
    t,
    up: 12 * 86400 + (t % 86400),
    load: [round2(base / 20), round2(base / 22), round2(base / 25)],
    cpu: { model: "Intel(R) Xeon(R) Platinum 8592+ CPU @ 1.90GHz", total: Math.round(cores.reduce((a, b) => a + b, 0) / n), cores, temps, pkg: Math.max(...temps) + 3, mhz: cores.map((c) => 800 + c * 30), physical: 64 },
    mem: { total: 257_536, used: Math.round(ram.used!), avail: 257_536 - Math.round(ram.used!), cached: 64_000, free: 90_000, swapTotal: 8_190, swapUsed: 1_240 },
    disks: [
      { path: "/var/lib/docker/overlay2", fs: "xfs", dev: "nvme1n1p1", size: 3_815_000, used: 3_548_000, avail: 267_000 },
      { path: "/srv/data", fs: "xfs", dev: "md127", size: 7_654_400, used: 5_210_000, avail: 2_444_400 },
      { path: "/mnt/backup-nvme-2tb", fs: "ext4", dev: "nvme2n1", size: 1_907_729, used: 801_000, avail: 1_106_729 },
      { path: "/", fs: "ext4", dev: "ubuntu--vg-ubuntu--lv", size: 1_906_000, used: 278_000, avail: 1_628_000 },
      { path: "/boot/efi", fs: "vfat", dev: "nvme0n1p1", size: 1_074, used: 6, avail: 1_068 },
    ],
    io: [
      { dev: "nvme0n1", r: Math.round(base * 40), w: Math.round(base * 90) },
      { dev: "nvme1n1", r: 1_260_000, w: Math.round(base * 20) },
      { dev: "nvme2n1", r: Math.round(base * 4), w: Math.round(base * 6) },
      { dev: "md127", r: Math.round(base * 30), w: Math.round(base * 70) },
    ],
    net: [
      { name: "enx00e04c6861f4", in: Math.round(940_000 * (0.5 + hash01(t))), out: Math.round(310_000 * (0.5 + hash01(t + 1))), rxT: 13_841_203, txT: 9_961_472 },
      { name: "eno2", in: Math.round(400 * (0.5 + hash01(t + 2))), out: Math.round(300 * (0.5 + hash01(t + 3))), rxT: 4_710, txT: 3_480 },
      { name: "wlp0s20f3", in: 0, out: 0, rxT: 12, txT: 3 },
      { name: "br-5f2c9a1e7b3d", in: Math.round(1_200 * hash01(t + 4)), out: Math.round(900 * hash01(t + 5)), rxT: 88_000, txT: 91_000 },
    ],
    procs: {
      count: 1_284,
      top: [
        pyA,
        pyB,
        pyC,
        proc(41022, "java", "kafka", 812.4, 48_213, 1_536, {
          file: "kafka.jar",
          cmd: "/usr/lib/jvm/java-17-openjdk-amd64/bin/java -Xms32g -Xmx32g -Dlog4j.configurationFile=/opt/kafka/config/log4j2.properties -cp /opt/kafka/libs/*:/opt/kafka/libs/extensions/* kafka.Kafka /opt/kafka/config/server.properties",
        }),
        proc(1893, "containerd-shim", "root", 2.1, 18, 12),
        proc(1204, "systemd-network", "systemd-network", 0.1, 9, 1),
        proc(3007, "postgres", "postgres", 0.4, 142, 1),
        proc(5920, "Xorg", "antpc", 0.3, 424, 2),
        proc(6955, "gnome-shell", "antpc", 0.2, 603, 81),
        proc(2676, "netdata", "netdata", 0.1, 202, 499),
        proc(3219, "grafana", "grafana", 0.1, 263, 51),
      ],
      groups: [
        { name: "java", n: 3, cpu: 815.2, mem: 51_900, ps: [] },
        { name: "python", n: 14, cpu: round1(base * 0.2), mem: 1_560, ps: [pyA, pyB, pyC] },
        { name: "containerd-shim", n: 48, cpu: 3.4, mem: 860 },
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

// ---------- demo logs and failures ----------

const DEMO_LINES: [number, string, string][] = [
  [6, "nginx.service", 'GET /api/orders 200 12ms "Mozilla/5.0"'],
  [6, "postgresql@16-main.service", "checkpoint complete: wrote 412 buffers (2.5%); 0 WAL file(s) added"],
  [6, "cron", "(root) CMD (/usr/local/bin/backup.sh --incremental)"],
  [4, "python3", "WARNING: slow query took 1830 ms: SELECT * FROM sensor_readings WHERE ..."],
  [6, "sshd", "Accepted publickey for antpc from 192.168.1.20 port 51522 ssh2"],
  [3, "grafana-server.service", "level=error msg=\"Failed to read plugin\" error=\"open /var/lib/grafana/plugins: permission denied\""],
  [6, "kernel", "eno1: Link is Up - 1Gbps/Full - flow control rx/tx"],
  [5, "systemd", "Started Daily apt download activities."],
  [6, "snap.nordvpn.nordvpnd.service", "Request: HTTP/1.1 POST https://applytics.nordvpn.com/v2/app/events map[Content-Encoding:[gzip] Content-Type:[application/json] User-Agent:[Moose/16.0.0 (linux; linux x86_64)]] (binary data)"],
  [4, "systemd-networkd-wait-online.service", "Timeout occurred while waiting for network connectivity on enx00e04c6861f4, br-5f2c9a1e7b3d"],
  [6, "nginx.service", '203.0.113.7 - - "GET /api/v2/search?q=temperature&from=2026-10-01T00:00:00Z&to=2026-10-13T23:59:59Z&fields=host,cpu,ram,disk,net&sort=-ts&page=17&per_page=500&token=•••&trace=4bf92f3577b34da6a3ce929d0e0e4736 HTTP/2.0" 200 18234 "https://dashboard.example.com/history?range=30d&metric=cpu"'],
  [3, "orders-api.service", '{"level":"error","ts":"2026-10-13T12:04:55.123Z","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","msg":"payment provider timeout","attempt":3,"upstream":"https://api.payments.example.com/v1/charges"}'],
  [6, "docker", "pulling layer sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08f2ca1bb6c7e907d06dafe4687e579fce76b37e4e93b7605022da52e6ccc26fd2"],
  [6, "netdata", "ALERT 'ram_in_use' cleared"],
]

/** Deterministic, slowly growing demo log: the cursor is the line's timestamp. */
export function demoLogs(after: string) {
  const now = Math.floor(Date.now() / 1000);
  const from = after ? Number(after) + 1 : now - 200;
  const entries = [];
  for (let t = Math.max(from, now - 600); t <= now; t++) {
    if (hash01(t * 13) > 0.35) continue; // about one line every 3 s
    const [p, u, m] = DEMO_LINES[Math.floor(hash01(t * 7) * DEMO_LINES.length)]!;
    entries.push({ c: String(t), t: t * 1000, p, u, m });
  }
  return { entries, cursor: String(now) };
}

/** A past window of demo lines, oldest first, paged by cursor (= unix second of the last line). */
export function demoRangeLogs(since: number, until: number, after: string, n = 500) {
  const end = Math.min(until || Infinity, Math.floor(Date.now() / 1000));
  const entries = [];
  let t = after ? Number(after) + 1 : since;
  for (; t <= end && entries.length < n; t++) {
    if (hash01(t * 13) > 0.35) continue;
    const [p, u, m] = DEMO_LINES[Math.floor(hash01(t * 7) * DEMO_LINES.length)]!;
    entries.push({ c: String(t), t: t * 1000, p, u, m });
  }
  return { entries, cursor: entries.length ? entries[entries.length - 1]!.c : after, more: t <= end, range: true };
}

export function demoEvents() {
  const now = Math.floor(Date.now() / 1000);
  const ev = (id: number, ago: number, severity: string, kind: string, source: string, message: string, count = 1) => ({
    id, ts: now - ago, last: now - ago + (count > 1 ? 120 : 0), count, severity, kind, source, message,
  });
  return [
    ev(9, 90, "error", "service", "systemd-networkd-wait-online.service", "upstream failed: " + "x-request-id=4bf92f3577b34da6;".repeat(30), 7),
    ev(8, 240, "critical", "crash", "orders-api.service", "panic: runtime error: index out of range [3] with length 3\n\ngoroutine 1 [running]:\nmain.handleCharge(0xc000112000)\n\t/srv/orders-api/internal/payments/charge_handler.go:142 +0x1d5\nmain.main()\n\t/srv/orders-api/cmd/server/main.go:57 +0x4a"),
    ev(7, 600, "warning", "cpu", "server-pulse", "CPU at 97% for 5+ minutes"),
    ev(6, 3_400, "error", "service", "grafana-server.service", "grafana-server.service: Failed with result 'exit-code'.", 3),
    ev(5, 26_000, "critical", "memory", "kernel", "Out of memory: Killed process 254142 (python3) total-vm:18342112kB"),
    ev(4, 90_000, "info", "online", "dashboard", "Server is reachable again (was offline for 14 minutes)."),
    ev(3, 90_840, "critical", "offline", "dashboard", "Server unreachable: Timed out after 8 s — server or tunnel is down"),
    ev(2, 180_000, "error", "log", "postgresql@16-main.service", "FATAL: password authentication failed for user \"report\"", 12),
    ev(1, 400_000, "warning", "disk", "server-pulse", "Disk / space at 91% for 1+ minutes"),
  ];
}
