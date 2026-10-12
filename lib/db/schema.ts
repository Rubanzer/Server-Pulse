import { bigserial, index, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

/** The server configured through env vars (SERVER_URL + shared passwords). Accounts get their own ids. */
export const ENV_SERVER = "env";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One server per account in v1 (HIS-9 multi-server = several rows per user later). */
export const servers = pgTable("servers", {
  id: text("id").primaryKey(),
  userId: text("user_id").unique(),
  /** AES-256-GCM encrypted server link; null until the owner connects. */
  linkEnc: text("link_enc"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
});

export const samples = pgTable(
  "samples",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    serverId: text("server_id").notNull().default(ENV_SERVER),
    /** Canonical metric key (cpu, ram, load, io, net, disk, temp), not the Netdata chart id. */
    chart: text("chart").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    /** Raw Netdata dimensions, e.g. { "user": 3.1, "system": 1.2 }. */
    values: jsonb("values").$type<Record<string, number>>().notNull(),
    resolutionS: integer("resolution_s").notNull(),
  },
  // The unique index also serves every (server, chart, ts) range scan, so no separate index is needed.
  (t) => [unique("samples_server_chart_ts_res").on(t.serverId, t.chart, t.ts, t.resolutionS)],
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    serverId: text("server_id").notNull().default(ENV_SERVER),
    kind: text("kind").notNull().default("sync"), // sync | backfill
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    rowsInserted: integer("rows_inserted"),
    status: text("status"), // ok | partial | error | offline
    error: text("error"),
  },
  (t) => [index("sync_runs_server_started").on(t.serverId, t.startedAt.desc())],
);

/** Key/value store. Per-server keys are prefixed "<serverId>:". */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
