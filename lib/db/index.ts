import "server-only";
import { neon } from "@neondatabase/serverless";
import { sql, type SQL } from "drizzle-orm";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { databaseUrl } from "@/lib/config";
import * as schema from "./schema";

type DB = NeonHttpDatabase<typeof schema>;

/**
 * `DATABASE_URL=pglite:./.data` runs an embedded Postgres for local development (no Neon account needed).
 * The import is hidden from the bundler so PGlite never ships to Vercel.
 */
async function connect(url: string): Promise<DB | null> {
  if (!url) return null;
  if (url.startsWith("pglite:")) {
    const dir = url.slice("pglite:".length) || "./.data";
    const g = globalThis as { __spPglite?: Promise<DB> }; // one instance across dev hot reloads
    g.__spPglite ??= (async () => {
      const { PGlite } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "@electric-sql/pglite");
      const { drizzle: pg } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "drizzle-orm/pglite");
      const { migrate } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "drizzle-orm/pglite/migrator");
      const d = pg(new PGlite(dir), { schema });
      await migrate(d, { migrationsFolder: "drizzle" });
      // ponytail: same query-builder API as neon-http; cast so callers see one type
      return d as unknown as DB;
    })();
    return g.__spPglite;
  }
  return drizzle(neon(url), { schema });
}

/** null when no database is connected — every caller must handle that (demo / env-only mode). */
export const db: DB | null = await connect(databaseUrl());
export { schema };

/** Rows affected by an `execute`, across drivers (neon: rowCount, pglite: affectedRows). */
export const affected = (r: unknown) => {
  const x = r as { rowCount?: number | null; affectedRows?: number };
  return x.rowCount ?? x.affectedRows ?? 0;
};

/**
 * The number a reading's peak is judged by, per chart: what its card headlines (CPU total, RAM and disk
 * used, 1-minute load, I/O and network summed, hottest sensor). Picks the hour's peak minute in rollups.
 */
export const peakRank = (chart: SQL, values: SQL) => sql`CASE ${chart}
  WHEN 'ram' THEN (${values}->>'used')::float8
  WHEN 'disk' THEN (${values}->>'used')::float8
  WHEN 'load' THEN (${values}->>'load1')::float8
  ELSE (SELECT sum(abs(x.value::float8)) FROM jsonb_each_text(${values}) x) END`; // writes / sent are stored negative
