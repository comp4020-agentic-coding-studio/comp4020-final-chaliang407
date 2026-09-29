const NAIVE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

// Stored `startsAt`/`endsAt` values are naive "YYYY-MM-DDTHH:mm" wall-clock
// strings with no timezone (see src/db/bookings.ts) — there's nothing to
// convert here, only to present. Building a Date from local components and
// formatting with the (implicit, local) system timezone reproduces the same
// wall-clock values that were stored, just in a friendlier shape.
function parseNaive(value: string): Date {
  const match = NAIVE_DATETIME_RE.exec(value);
  if (!match) return new Date(Number.NaN);
  const [, y, mo, d, h, mi] = match.map(Number);
  return new Date(y, mo - 1, d, h, mi);
}

const dateFormatter = new Intl.DateTimeFormat("en-AU", {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const timeFormatter = new Intl.DateTimeFormat("en-AU", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

export function formatDateTimeRange(startsAt: string, endsAt: string): string {
  const start = parseNaive(startsAt);
  const end = parseNaive(endsAt);

  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();

  const startDate = dateFormatter.format(start);
  const startTime = timeFormatter.format(start);
  const endTime = timeFormatter.format(end);

  if (sameDay) {
    return `${startDate} · ${startTime} – ${endTime}`;
  }
  const endDate = dateFormatter.format(end);
  return `${startDate} ${startTime} – ${endDate} ${endTime}`;
}
