import type { APIRoute } from "astro";
import { createBooking, listBookings } from "../../../db/bookings.ts";
import { db } from "../../../db/client.ts";

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const GET: APIRoute = async () => {
  return json(listBookings(db), 200);
};

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "request body must be JSON" }, 400);
  }
  if (typeof body !== "object" || body === null) {
    return json({ error: "request body must be a JSON object" }, 400);
  }

  const result = createBooking(db, body as Record<string, unknown>);
  if (!result.ok) return json({ error: result.error }, result.status);
  return json(result.booking, 201);
};
