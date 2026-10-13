"use client";

/**
 * reader.read() with an idle watchdog: a half-open connection (tunnel dropped without a FIN) would
 * otherwise leave the read pending forever and the page showing "Live" on frozen data. After `ms`
 * without a byte it aborts the fetch (via onIdle) and throws, so the caller reconnects or falls back.
 */
export async function readIdle<T>(reader: ReadableStreamDefaultReader<T>, ms: number, onIdle: () => void): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onIdle();
      reject(new Error("the stream went quiet"));
    }, ms);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    clearTimeout(timer);
  }
}

/** Live frames arrive every second; the log stream sends a heartbeat every 20 s. */
export const PULSE_IDLE_MS = 10_000;
export const LOGS_IDLE_MS = 45_000;
