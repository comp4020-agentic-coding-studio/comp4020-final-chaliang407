# Process overview

Built in four directed stages, each a separate scoped instruction, checked
against the running app before moving on.

**1. Foundation** — [`8a5de74`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/8a5de74)
set up Astro + Drizzle + SQLite: a minimal rooms/bookings schema and seeded
demo rooms. Deliberately kept to a small room-booking slice, not a full
enrolment or timetabling system.

**2. Core flow** — [`d1d8238`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/d1d8238)
added create, read, and cancel, with server-side overlap validation. Before
committing, I manually created a booking in the browser, refreshed the page,
and confirmed it was still there — not just that the tests were green.

**3. Interaction correction** — Looking at the running app, rather than
trusting green tests, showed the room list was disconnected from the booking
form (read a name, then re-select it in a separate dropdown) and timestamps
were raw ISO strings. I had the agent correct this to per-room booking (each
room card opens its own form) and human-readable date/times, then do a
visual-only polish pass, verifying both against the running app before
committing as [`188fb85`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/188fb85).

**4. Production grounding** — A real Fly deployment exposed three things
local tests never caught: `better-sqlite3` needed a native build toolchain,
the server wasn't binding `0.0.0.0`, and cancellation returned 403 behind
Fly's HTTPS-terminating proxy (an Origin/CSRF mismatch). Each fix was driven
by that deployment evidence, not assumption. Verified end to end over the
live HTTPS URL: create (201), persisted read-back, overlap rejected (409),
cancel (200), confirmed gone —
[`e6f4abc`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/e6f4abc).

**How I directed this** — Small, explicit iterations, never one open-ended
instruction. Nothing was accepted on the agent's word: I checked the running
app myself, in the browser and then over production HTTPS, before any
commit, and every correction came from what I actually observed, not what
the agent claimed.
