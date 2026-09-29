import { expect, inject, it } from "vitest";

// Proves the database foundation, not the (not-yet-built) booking flow:
// migrations ran and the demo rooms were seeded, reachable over HTTP.
const baseUrl = inject("baseUrl");

it("serves seeded demo rooms as JSON", async () => {
  const res = await fetch(new URL("/api/rooms", baseUrl));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");

  const rooms = await res.json();
  expect(Array.isArray(rooms)).toBe(true);
  expect(rooms.length).toBeGreaterThan(0);

  for (const room of rooms) {
    expect(typeof room.id).toBe("number");
    expect(typeof room.name).toBe("string");
    expect(typeof room.location).toBe("string");
    expect(typeof room.capacity).toBe("number");
  }
});

it("keeps returning the same seeded rooms across requests (no duplicate seeding)", async () => {
  const first = await (await fetch(new URL("/api/rooms", baseUrl))).json();
  const second = await (await fetch(new URL("/api/rooms", baseUrl))).json();
  expect(second.length).toBe(first.length);
  expect(second.map((r: { id: number }) => r.id)).toEqual(first.map((r: { id: number }) => r.id));
});
