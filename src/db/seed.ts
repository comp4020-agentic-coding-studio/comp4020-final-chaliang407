import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";
import { rooms, type NewRoom } from "./schema.ts";

// Fictional demo data only — no real ANU room-booking system is queried or
// represented here.
const DEMO_ROOMS: NewRoom[] = [
  { name: "Nook 3B (Demo)", location: "Fictional Chifley Annex, Level 3", capacity: 2 },
  { name: "Pod 7 (Demo)", location: "Fictional Hancock Annex, Level 1", capacity: 4 },
  { name: "Study Room 12 (Demo)", location: "Fictional Kambri Annex, Level 2", capacity: 6 },
];

// Idempotent: only inserts if the table is empty, so redeploys and CI's
// throwaway /data don't accumulate duplicate rows.
export function seed(db: BetterSQLite3Database<typeof schema>): void {
  const existing = db.select().from(rooms).limit(1).all();
  if (existing.length > 0) return;
  for (const room of DEMO_ROOMS) db.insert(rooms).values(room).run();
}
