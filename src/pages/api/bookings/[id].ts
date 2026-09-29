import type { APIRoute } from "astro";
import { cancelBooking } from "../../../db/bookings.ts";
import { db } from "../../../db/client.ts";

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const DELETE: APIRoute = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return json({ error: "invalid booking id" }, 400);
  }

  const cancelled = cancelBooking(db, id);
  if (!cancelled) return json({ error: "booking not found" }, 404);
  return json({ id }, 200);
};
