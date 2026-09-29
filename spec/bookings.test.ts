import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");
// Astro's built-in CSRF protection (security.checkOrigin, on by default)
// rejects non-GET requests whose Origin header doesn't match the request's
// own origin. A real browser sends this automatically; a bare Node fetch
// doesn't, so tests add it explicitly to act like a legitimate same-origin
// client rather than disabling the protection.
const sameOrigin = new URL(baseUrl).origin;

async function getRooms() {
  const res = await fetch(new URL("/api/rooms", baseUrl));
  return res.json();
}

async function createBooking(body: Record<string, unknown>) {
  return fetch(new URL("/api/bookings", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", origin: sameOrigin },
    body: JSON.stringify(body),
  });
}

async function cancelBooking(id: number | string) {
  return fetch(new URL(`/api/bookings/${id}`, baseUrl), {
    method: "DELETE",
    headers: { origin: sameOrigin },
  });
}

it("creates a booking, reads it back, rejects an overlap, then cancels it", async () => {
  const rooms = await getRooms();
  expect(rooms.length).toBeGreaterThan(0);
  const room = rooms[0];

  // Far in the future and specific to this test, so leftover data from a
  // previous local run (the dev DB isn't reset between test runs) can't
  // collide with it.
  const startsAt = "2099-06-01T09:00";
  const endsAt = "2099-06-01T10:00";

  const createRes = await createBooking({
    roomId: room.id,
    bookedBy: "Foundation Test",
    startsAt,
    endsAt,
  });
  expect(createRes.status).toBe(201);
  const created = await createRes.json();
  expect(created.roomId).toBe(room.id);
  expect(created.startsAt).toBe(startsAt);
  expect(created.endsAt).toBe(endsAt);

  const listed = await (await fetch(new URL("/api/bookings", baseUrl))).json();
  expect(listed.some((b: { id: number }) => b.id === created.id)).toBe(true);

  // Overlapping slot on the same room is rejected...
  const overlapRes = await createBooking({
    roomId: room.id,
    bookedBy: "Overlap Test",
    startsAt: "2099-06-01T09:30",
    endsAt: "2099-06-01T10:30",
  });
  expect(overlapRes.status).toBe(409);

  // ...but the identical slot on a different room is unaffected.
  if (rooms.length > 1) {
    const otherRoomRes = await createBooking({
      roomId: rooms[1].id,
      bookedBy: "Different Room Test",
      startsAt,
      endsAt,
    });
    expect(otherRoomRes.status).toBe(201);
    const otherBooking = await otherRoomRes.json();
    await cancelBooking(otherBooking.id);
  }

  const cancelRes = await cancelBooking(created.id);
  expect(cancelRes.status).toBe(200);

  const afterCancel = await (await fetch(new URL("/api/bookings", baseUrl))).json();
  expect(afterCancel.some((b: { id: number }) => b.id === created.id)).toBe(false);
});

it("rejects a booking whose end time is not after its start time", async () => {
  const rooms = await getRooms();
  const res = await createBooking({
    roomId: rooms[0].id,
    bookedBy: "Invalid Test",
    startsAt: "2099-07-01T10:00",
    endsAt: "2099-07-01T09:00",
  });
  expect(res.status).toBe(400);
});

it("rejects a booking for a room that doesn't exist", async () => {
  const res = await createBooking({
    roomId: 999999,
    bookedBy: "Ghost Room Test",
    startsAt: "2099-08-01T10:00",
    endsAt: "2099-08-01T11:00",
  });
  expect(res.status).toBe(404);
});

it("cancelling a booking that doesn't exist returns 404", async () => {
  const res = await cancelBooking(999999);
  expect(res.status).toBe(404);
});
