import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

const COOKIE_NAME = "voter_id";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

// Anonymous per-browser identity: a random id in a cookie, no accounts, no
// username, nothing identifying — created on first contact, reused after.
export function getOrCreateVoterId(req: IncomingMessage, res: ServerResponse): string {
  const existing = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (existing) return existing;

  const id = randomUUID();
  res.setHeader(
    "set-cookie",
    `${COOKIE_NAME}=${id}; Max-Age=${MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax`,
  );
  return id;
}
