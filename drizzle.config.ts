import { defineConfig } from "drizzle-kit";

// Only used by `pnpm db:generate` to produce SQL under drizzle/; nothing
// here runs at app boot — src/db/client.ts applies the generated migrations
// itself via drizzle-orm's migrator.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
