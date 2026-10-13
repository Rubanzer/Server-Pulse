import { bigserial, index, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
    /** Hourly rows only: the hour's peak minute (whole reading), so long ranges keep true peaks. */
    peaks: jsonb("peaks").$type<Record<string, number>>(),
    resolutionS: integer("resolution_s").notNull(),
  },
  // The unique index also serves every (server, chart, ts) range scan, so no separate index is needed.
  (t) => [
    unique("samples_server_chart_ts_res").on(t.serverId, t.chart, t.ts, t.resolutionS),
    // the nightly rollup finds minute rows older than 30 days by time alone: without this it scans the table
    index("samples_fine_ts").on(t.ts).where(sql`${t.resolutionS} < 3600`),
  ],
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

/**
 * One-time pairing codes from the "Add server" screen. Only a SHA-256 of the code is stored; a code works
 * once, for 10 minutes, and binds the agent that redeems it to the server row of whoever created it.
 */
export const pairings = pgTable(
  "pairings",
  {
    codeHash: text("code_hash").primaryKey(),
    serverId: text("server_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    hostname: text("hostname"),
    agentVersion: text("agent_version"),
    error: text("error"),
    /** Link the agent handed over, AES-GCM encrypted, until the owner approves or rejects it. */
    pendingLinkEnc: text("pending_link_enc"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  },
  (t) => [index("pairings_server").on(t.serverId)],
);

/**
 * Failure history: errors and crashes from the server's logs, sustained threshold breaches (both found
 * by the agent), and what the dashboard itself sees (server offline / back online, sync failures).
 * `key` makes re-syncing idempotent: "<agent epoch>:<agent event id>" or "dash:<uuid>".
 */
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    serverId: text("server_id").notNull(),
    key: text("key").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    lastAt: timestamp("last_at", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
    severity: text("severity").notNull(), // critical | error | warning | info
    kind: text("kind").notNull(), // log | service | memory | disk | crash | cpu | temp | offline | online | sync
    source: text("source").notNull().default(""),
    message: text("message").notNull(),
  },
  (t) => [unique("events_server_key").on(t.serverId, t.key), index("events_server_ts").on(t.serverId, t.ts.desc())],
);

/** Key/value store. Per-server keys are prefixed "<serverId>:". */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
