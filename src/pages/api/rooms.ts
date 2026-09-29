import type { APIRoute } from "astro";
import { db } from "../../db/client.ts";
import { rooms } from "../../db/schema.ts";

// Proves the backend/database connection end to end: no booking flow yet,
// just the seeded rooms coming back out of SQLite as JSON.
export const GET: APIRoute = async () => {
  const all = db.select().from(rooms).all();
  return new Response(JSON.stringify(all), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
