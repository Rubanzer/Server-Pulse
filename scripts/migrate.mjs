// Runs at build time. Skips cleanly without a database so `npm run build` works with no env vars.
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.log("[migrate] no DATABASE_URL — skipping migrations");
} else if (url.startsWith("pglite:")) {
  console.log("[migrate] embedded PGlite migrates itself on first use");
} else {
  await migrate(drizzle(neon(url)), { migrationsFolder: "drizzle" });
  console.log("[migrate] database is up to date");
}
