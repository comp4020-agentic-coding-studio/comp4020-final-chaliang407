import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";
import { bookings, rooms } from "./schema.ts";

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

// "YYYY-MM-DDTHH:mm" (the shape a datetime-local input produces). Validity is
// checked by round-tripping through Date.UTC — catches out-of-range values
// like 2026-02-30 or 24:00 that the regex alone would accept. Being
// fixed-width and zero-padded means plain string comparison already sorts
// and orders these correctly, so nothing else in this module needs
// timezone-aware Date parsing.
function isValidDateTime(value: string): boolean {
  const match = DATETIME_RE.exec(value);
  if (!match) return false;
  const [, y, mo, d, h, mi] = match.map(Number);
  const asUtc = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return (
    asUtc.getUTCFullYear() === y &&
    asUtc.getUTCMonth() === mo - 1 &&
    asUtc.getUTCDate() === d &&
    asUtc.getUTCHours() === h &&
    asUtc.getUTCMinutes() === mi
  );
}

export type CreateBookingResult =
  | { ok: true; booking: typeof bookings.$inferSelect }
  | { ok: false; status: number; error: string };

export function createBooking(
  db: BetterSQLite3Database<typeof schema>,
  input: Record<string, unknown>,
): CreateBookingResult {
  const roomId = Number(input.roomId);
  if (!Number.isInteger(roomId) || roomId <= 0) {
    return { ok: false, status: 400, error: "roomId must be a positive integer" };
  }

  const bookedBy = typeof input.bookedBy === "string" ? input.bookedBy.trim() : "";
  if (bookedBy.length === 0 || bookedBy.length > 200) {
    return { ok: false, status: 400, error: "bookedBy must be 1-200 characters" };
  }

  const { startsAt, endsAt } = input;
  if (typeof startsAt !== "string" || !isValidDateTime(startsAt)) {
    return { ok: false, status: 400, error: "startsAt must be a valid YYYY-MM-DDTHH:mm value" };
  }
  if (typeof endsAt !== "string" || !isValidDateTime(endsAt)) {
    return { ok: false, status: 400, error: "endsAt must be a valid YYYY-MM-DDTHH:mm value" };
  }
  if (endsAt <= startsAt) {
    return { ok: false, status: 400, error: "endsAt must be after startsAt" };
  }

  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();
  if (!room) {
    return { ok: false, status: 404, error: "room not found" };
  }

  return db.transaction((tx) => {
    const existing = tx.select().from(bookings).where(eq(bookings.roomId, roomId)).all();
    const overlaps = existing.some((b) => b.startsAt < endsAt && startsAt < b.endsAt);
    if (overlaps) {
      return { ok: false, status: 409, error: "room already booked for that time" } as const;
    }
    const [booking] = tx.insert(bookings).values({ roomId, bookedBy, startsAt, endsAt }).returning().all();
    return { ok: true, booking } as const;
  });
}

export function listBookings(db: BetterSQLite3Database<typeof schema>) {
  return db
    .select({
      id: bookings.id,
      roomId: bookings.roomId,
      roomName: rooms.name,
      roomLocation: rooms.location,
      bookedBy: bookings.bookedBy,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      createdAt: bookings.createdAt,
    })
    .from(bookings)
    .leftJoin(rooms, eq(bookings.roomId, rooms.id))
    .orderBy(bookings.startsAt)
    .all();
}

// Hard delete: there's no "cancelled" status in this iteration, so a
// cancelled booking simply no longer exists — which is itself what makes the
// cancellation persist across a reload.
export function cancelBooking(db: BetterSQLite3Database<typeof schema>, id: number): boolean {
  const result = db.delete(bookings).where(eq(bookings.id, id)).run();
  return result.changes > 0;
}
