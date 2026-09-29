import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";
import { seed } from "./seed.ts";

// /data is the only storage that survives a Fly restart or redeploy
// (fly.toml mounts the volume there); NODE_ENV=production is set in the
// Dockerfile's runtime stage. DB_PATH overrides either default, which CI/tests
// use to point at an isolated file.
const DB_PATH =
  process.env.DB_PATH ?? (process.env.NODE_ENV === "production" ? "/data/app.db" : ".data/dev.db");

const dir = dirname(DB_PATH);
if (dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });

// Migrations are generated ahead of time (`pnpm db:generate`) and committed
// under drizzle/; applying them here makes every boot — first deploy, a
// redeploy, or a throwaway CI /data — end up with an up-to-date schema.
migrate(db, { migrationsFolder: "drizzle" });

seed(db);
