# Process overview

This app was built in five directed stages: a data/backend foundation, a
persistent booking flow, manual browser testing that surfaced real interaction
problems, a correction of those problems followed by a final visual pass, and
a production-deployment pass that fixed real Fly.io failures the local tests
never caught. Nothing here was auto-generated in one shot — each stage was a
separate, scoped instruction to the agent, checked before I let it move to
the next one.

## 1. Foundation

[`8a5de74`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/8a5de74)
set up the Astro + Drizzle + SQLite stack: a minimal `rooms`/`bookings`
schema, one migration, a few seeded demo rooms, and production storage under
`/data` (the only path that survives a Fly.io redeploy). No booking behaviour
yet — just a base the rest could be built on.

## 2. Persistent booking flow

[`d1d8238`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/d1d8238)
added the smallest complete flow: see the rooms, create a booking, see it
immediately, and cancel it — with server-side validation (end time after
start time, and rejecting an overlapping booking on the same room) and tests
covering create, persistence, overlap rejection, and cancellation. I
deliberately kept this scoped to the flow itself: no accounts, no calendar
view, no admin screen.

Before committing this, I had the agent start the app and I manually tested
persistence myself: created a booking in the browser, refreshed the page, and
confirmed the booking was still there. Only after that manual check passed
did I tell the agent to commit.

## 3. Manual browser testing found real problems

Once d1d8238 was committed, I looked at the running app properly rather than
just trusting that the tests were green. It worked, but it did not look or
behave like a finished thing:

- the page looked almost entirely like unstyled default HTML
- "Available rooms" was a plain list, disconnected from the booking form —
  you had to read a room's name off the list, then find and select the same
  room again in a separate dropdown
- booking times were shown as raw stored values like `2026-09-30T19:46`
  instead of anything a person would read comfortably
- there was no visual hierarchy pointing at "find a room, book it" as the one
  thing this page is for

## 4. Interaction correction and final polish

I gave the agent those specific problems and told it explicitly not to expand
the product to fix them — only to correct the interaction and visual design.
The fix that mattered most: instead of one global booking form driven by a
room dropdown, each room card now opens its own booking form directly (a
native `<details>` toggle, no JS required for the expand/collapse), so
choosing a room and booking it are the same action instead of two things you
have to keep in sync yourself. Raw timestamps were replaced with a formatted,
human-readable date/time range wherever a booking is shown. I asked for this
without touching anything about how bookings are actually validated, stored,
or cancelled, and had the agent confirm that with the existing test suite
plus a manual create/overlap/cancel check against the running app before I'd
look at it.

I reviewed that in the browser and it was the right interaction; what was
left was purely visual — hierarchy, spacing, hover/focus feedback, and making
the booking-list date/time the most prominent thing on the page rather than
an afterthought below the room name. I asked for a second, visual-only pass
with an explicit list of what to leave alone (no new features, no gradients
or decoration-for-its-own-sake, keep the restrained neutral palette). I held
off committing either the interaction correction or the polish pass until I
had reviewed both in the browser myself, and only asked for a final
regression check — re-verifying the persisted booking still survived a
reload, and that booking, overlap rejection, and cancellation still worked
end to end — before committing both together as
[`188fb85`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/188fb85).

## 5. Making the real deployment work

Deploying to Fly.io surfaced problems local testing never hit. `pnpm build`
and the tests were green locally, but the first real remote build failed:
`better-sqlite3` has no prebuilt binary for that platform, so `pnpm install`
compiles it, and the runtime
image had no C/C++ toolchain to do that with. Adding, then removing, that
toolchain in the Dockerfile fixed the build — but the deployed machine still
refused every connection, because `@astrojs/node`'s `host: true` option is
inert in the installed version and falls back to Astro's own `server.host`
default of `false`. Setting `HOST=0.0.0.0` in `fly.toml`, read first by the
adapter at runtime, fixed reachability.

With the app reachable over HTTPS, a production smoke test found a third
problem: cancelling a booking returned 403 behind Fly's TLS-terminating
proxy, while creating one didn't. Astro's CSRF check compares the browser's
`Origin` against the app's own computed origin, which is always `http://`
behind Fly's proxy — but that strict comparison only applies to requests
without a form-like `content-type`, which the cancel request lacked and the
create request didn't. Rather than weaken or disable the origin check, the
cancel request was changed to send `content-type: application/json`,
matching the create request and landing on the same code path Astro already
treats as safe. A full production pass then confirmed the fix end to end:
`/` and `/readme/` both 200, a booking created (201) and read back across
separate requests, an overlap rejected (409), and the booking cancelled (200)
and confirmed gone — committed as
[`e6f4abc`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/e6f4abc).

## How I directed and checked the agent's work

Every stage above was a separate, explicit instruction with a stated scope
("this iteration only," what not to touch), not a single open-ended
"build me a room booking app." Before any non-trivial change, I had the agent
explain what it was about to do and why, so I could catch scope creep before
it was written rather than after. After each change, it had to report back
concretely: which files changed, what actually changed in behaviour versus
appearance, whether backend behaviour changed at all, and the real output of
`pnpm typecheck`, `pnpm build`, and the test suite — not just an assertion
that things worked.

I never had it commit as part of the same turn it made a change in. Every
commit was a separate, explicit "commit now" after I had either watched it
work in the browser myself or asked for a specific regression check first.
`PROCESS.md`, this file, and `reflections/` were both off-limits to the agent
until I asked for them directly, so the record here reflects what I reviewed,
not what the agent chose to write about itself along the way.
