# ADR 0002: Server-Sent Events for real-time delivery, SQLite stays authoritative

## Status

Accepted, C9 (week 10).

## Context

C9 requires a change made by one player to reach every other open session
within about a second, without a reload. C8 shipped fixed-interval polling
(`POLL_MS = 1200` in the pre-C9 `public/index.html`), which is usually fast
but not *reliably* within a second: a bystander tab's own poll phase is
unsynchronized with when a round actually resolves, and Fly's
`auto_stop_machines`/`min_machines_running = 0` (`fly.toml`) means a poll can
land on a cold-starting machine with no bound on the delay.

## Decision

Use Server-Sent Events (`GET /api/events`, `src/http/events.ts`) as a
one-directional, content-free notification channel, with SQLite remaining
the only authoritative state and the existing `GET /api/state` /
`POST /api/vote` endpoints remaining the only way to read or change it. The
SSE layer holds no game state of its own — only an in-memory set of open
connections and one pending deadline timer, both explicitly non-authoritative
and lost on restart. Every client resyncs by calling the real `GET
/api/state` after each `resolved` event, on initial `EventSource` connection,
and on every browser-driven reconnect (`onopen`).

## Comparison

| | Fast polling (e.g. 300ms) | WebSockets | **SSE (chosen)** |
|---|---|---|---|
| Fits this app's data flow | Pull, still phase-misaligned across tabs | Full duplex — this app has no client→server push need beyond the existing REST `POST /api/vote` | Server→client only, which is the actual direction needed |
| New dependencies | None | A `ws` library or a hand-rolled upgrade handshake | None — plain `node:http`, matching `Dockerfile`'s "no Express, no bundler" approach |
| Reconnect | N/A (stateless polls) | Manual — browsers don't auto-reconnect `WebSocket` | Native — `EventSource` reconnects on its own |
| Request volume / Fly cost | ~4x C8's polling, more frequent machine wake-ups | One long-lived connection per tab | One long-lived connection per tab |
| Implementation size | Smallest, but doesn't fix the root cause | Largest — new protocol surface, reconnect/backoff logic, more to keep consistent with SQLite | Smallest change that actually removes phase misalignment |

Fast polling was rejected because it's a smaller version of the same
problem, not a fix for it. WebSockets were rejected as disproportionate: this
app has no duplex requirement, and a second protocol surface is more
machinery than "notify tabs a round resolved" needs.

## Implementation complexity and synchronization

The hub (`src/http/events.ts`) coalesces notifications: `ensureCurrentRound`
can resolve several overdue rounds in one synchronous pass (e.g. after the
Fly machine was stopped across more than one round), and the hub collapses
any number of resolutions arriving before the next microtask into exactly
one broadcast and one timer rearm, rather than one of each per backlogged
round. A proactive `setTimeout` scheduled at the open round's own deadline
pushes a notification the moment a round closes; `ensureCurrentRound`'s lazy,
request-triggered resolution (needed because the process itself can stop
between requests) is left completely intact as the fallback if the timer is
ever delayed or the process restarts. Every write path (`res.write` for
broadcasts and heartbeats) is wrapped so a single broken socket can be
dropped without taking the whole process, and every other player's
connection, down with it.

## Privacy

The broadcast payload is literally `data: {}` — there is no field to leak
because none exists. `hasVoted` and all tallies are computed inside
`buildStatePayload`, called once, from the one authoritative place
(`src/api.ts`), and the SSE layer never reads or forwards any of it. See ADR
0001 for the full hidden-votes rationale.

## Fly.io considerations

`fly.toml`'s cost model rests on `auto_stop_machines = "stop"` with
`min_machines_running = 0` — the machine stops when idle. SSE connections are
long-lived by design, and **whether Fly's proxy treats an open streamed
response as "active traffic" for idle-detection purposes has not been
verified against a real deployment.** This is called out explicitly rather
than assumed: it can only be confirmed by observing production behaviour
after a real deploy, which has not happened as of this ADR. A 20-second
heartbeat comment (`src/http/events.ts`) is sent purely to survive
intermediary idle timeouts (proxies, browsers) — it is not evidence either
way about Fly's own auto-stop classification.

## Consequence

Correctness (hidden tallies, lazy resolution, one vote per voter) depends on
nothing in this layer — it depends entirely on SQLite and the existing
request handlers, exactly as before. SSE only changes how quickly a client
learns to go ask for the truth.
