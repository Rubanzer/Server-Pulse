// Pure, dependency-free helpers. Kept free of "@/" imports so `node --test` can run them directly.

/** Fixed-capacity circular buffer: O(1) push, O(n) snapshot. Used for live sparklines and charts. */
export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0; // next write position
  private len = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
    this.capacity = capacity;
    this.buf = new Array(capacity);
  }

  get size() {
    return this.len;
  }

  push(v: T) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.len < this.capacity) this.len++;
  }

  /** Oldest → newest. */
  toArray(): T[] {
    const out: T[] = new Array(this.len);
    const start = (this.head - this.len + this.capacity) % this.capacity;
    for (let i = 0; i < this.len; i++) out[i] = this.buf[(start + i) % this.capacity] as T;
    return out;
  }

  last(): T | undefined {
    return this.len ? this.buf[(this.head - 1 + this.capacity) % this.capacity] : undefined;
  }
}

/**
 * k-th smallest element (0-based) via iterative Hoare quickselect with median-of-three pivot.
 * O(n) average, O(1) extra space; mutates `a`.
 */
function select(a: number[], k: number): number {
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // median-of-three keeps sorted / reverse-sorted input out of the O(n²) case
    if (a[mid]! < a[lo]!) swap(a, mid, lo);
    if (a[hi]! < a[lo]!) swap(a, hi, lo);
    if (a[hi]! < a[mid]!) swap(a, hi, mid);
    const pivot = a[mid]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i]! < pivot) i++;
      while (a[j]! > pivot) j--;
      if (i <= j) swap(a, i++, j--);
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k]!;
  }
  return a[k]!;
}

function swap(a: number[], i: number, j: number) {
  const t = a[i]!;
  a[i] = a[j]!;
  a[j] = t;
}

/** Nearest-rank quantile (q in [0,1]) in O(n) average. Ignores non-finite values. */
export function quantile(values: readonly number[], q: number): number | null {
  const a = values.filter(Number.isFinite);
  if (!a.length) return null;
  const k = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1));
  return select(a, k);
}

export type Stats = { avg: number; peak: number; p95: number; min: number; count: number };

/** avg / min / peak in one pass, p95 via quickselect. O(n) total. */
export function stats(values: readonly number[]): Stats | null {
  let sum = 0;
  let count = 0;
  let peak = -Infinity;
  let min = Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    sum += v;
    count++;
    if (v > peak) peak = v;
    if (v < min) min = v;
  }
  if (!count) return null;
  return { avg: sum / count, peak, min, p95: quantile(values, 0.95)!, count };
}

/**
 * TTL cache + single-flight: concurrent callers share one in-flight promise, and the
 * result is reused for `ttlMs`. Failures are not cached, so the next call retries.
 */
export function cached<T>(fn: () => Promise<T>, ttlMs: () => number, now: () => number = Date.now) {
  let value: { v: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;
  const get = (): Promise<T> => {
    if (value && now() - value.at < ttlMs()) return Promise.resolve(value.v);
    if (inflight) return inflight;
    inflight = fn()
      .then((v) => {
        value = { v, at: now() };
        return v;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  get.reset = () => {
    value = null;
  };
  return get;
}

export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Bucket width (seconds) that keeps a range at ≈`points` points, never finer than `min`. */
export function bucketStep(rangeSec: number, points = 500, min = 60): number {
  return Math.max(min, Math.ceil(rangeSec / points));
}

/** Merge several [ts, value] series into one by taking the max per timestamp. O(n) via a hash map. */
export function mergeMax(series: readonly (readonly [number, number])[][]): [number, number][] {
  const m = new Map<number, number>();
  for (const s of series)
    for (const [t, v] of s) {
      const cur = m.get(t);
      if (cur === undefined || v > cur) m.set(t, v);
    }
  return [...m].sort((a, b) => a[0] - b[0]);
}

/** Deterministic pseudo-random in [0,1) from an integer seed (mulberry32 step). Used by demo data. */
export function hash01(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Fixed-window counter per key, with O(1) amortized cleanup. Used to rate-limit login attempts. */
export class WindowLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Returns true if the attempt is allowed. */
  hit(key: string): boolean {
    const t = this.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    const e = this.hits.get(key);
    if (!e || e.reset <= t) {
      this.hits.set(key, { n: 1, reset: t + this.windowMs });
      return true;
    }
    return ++e.n <= this.max;
  }

  clear(key: string) {
    this.hits.delete(key);
  }
}

/**
 * Smooth SVG path through points using monotone cubic interpolation (Fritsch–Carlson).
 * Unlike Catmull-Rom it never overshoots: a series that stays ≥ 0 never dips below 0 and peaks
 * are never exaggerated. O(n). xs must be strictly increasing.
 */
export function monotonePath(xs: readonly number[], ys: readonly number[]): string {
  const n = xs.length;
  if (n === 0) return "";
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  if (n === 1) return `M${f(xs[0]!)},${f(ys[0]!)}`;
  const d: number[] = new Array(n - 1); // secant slopes
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]! || 1);
  const m: number[] = new Array(n); // tangents
  m[0] = d[0]!;
  m[n - 1] = d[n - 2]!;
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  let p = `M${f(xs[0]!)},${f(ys[0]!)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = (xs[i + 1]! - xs[i]!) / 3;
    p += `C${f(xs[i]! + h)},${f(ys[i]! + m[i]! * h)},${f(xs[i + 1]! - h)},${f(ys[i + 1]! - m[i + 1]! * h)},${f(xs[i + 1]!)},${f(ys[i + 1]!)}`;
  }
  return p;
}

/** Index of the element closest to `t` in an ascending array. O(log n); -1 when empty. */
export function nearestIndex(sorted: readonly number[], t: number): number {
  if (!sorted.length) return -1;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(sorted[lo - 1]! - t) <= Math.abs(sorted[lo]! - t) ? lo - 1 : lo;
}

/** Smallest "nice" axis maximum (1, 2, 2.5, 5 × 10^k) ≥ v. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

/** Least-recently-used cache on a Map (insertion order = recency): O(1) get/set/evict. */
export class Lru<K, V> {
  private m = new Map<K, V>();
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  get(k: K): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  /** Read without touching recency (safe during render). */
  peek(k: K): V | undefined {
    return this.m.get(k);
  }
  set(k: K, v: V) {
    this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as K);
  }
}
