# Process overview: C8 → C9

C8 (documented in the previous version of this file, preserved in git history
at [`b70751b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/b70751b35176ea5ab3a4d456fcc0a8f06dcbba0b))
left the app with SQLite persistence, anonymous voting, hidden open-round
tallies, and a browser that polled for state. C9's brief is specific about
what was still missing: a change one person makes has to reach every other
open session within about a second, with no reload, and one decision about
multi-player behaviour has to be made and written down.

## Read-only audit before writing any code

Rather than start implementing immediately, the first step was a read-only
technical and design audit of the C8 codebase against the C9 brief:
`src/server.ts`, `src/api.ts`, `src/game/lifecycle.ts`, `src/db/`, and
`public/index.html`'s polling logic specifically. That audit established the
actual failure mode in C8's polling: `POLL_MS = 1200` is usually fast, but a
bystander tab's poll is phase-unsynchronized with when a round actually
resolves, and `fly.toml`'s `auto_stop_machines`/`min_machines_running = 0`
means a poll can land on a cold-starting machine with no bound on the delay.
"Usually under a second" isn't the same claim as "reliably under a second,"
and the brief asks for the latter. The audit also compared SSE, WebSockets,
and faster polling against this specific architecture: this app has no
client→client or even client→server push need beyond the existing
`POST /api/vote`, so WebSockets' full duplex protocol buys nothing and only
adds a new dependency, manual reconnect/backoff logic, and more surface to
keep consistent with SQLite; fast polling is a smaller version of the same
phase-misalignment problem, not a fix for it. SSE matched the actual
direction of the data (server to client only), needed no new dependency on
top of plain `node:http`, and gave reconnection for free via the browser's
own `EventSource`. Before any code was written, that recommendation was
checked against an explicit constraint carried over from the brief: receiving
updates quickly is not the same claim as showing live vote totals, and the
two had to stay separate through the whole design, not just at the end.

## Implementation, in one deliberate commit

The real-time layer landed in
[`a7fad4e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/a7fad4e6437ad1d458b172c8413dc7cdec2de36c):
`src/api.ts` gained `buildStatePayload`, extracted so `GET /api/state` and
nothing else is the one place tallies can be read, and so a future caller
can't accidentally duplicate the hidden-vote logic; `src/http/events.ts` is
new, a `GET /api/events` SSE endpoint whose broadcast payload is literally
`data: {}` — no action, no count, nothing to leak, by construction rather
than by convention; `src/game/lifecycle.ts`'s `ensureCurrentRound` now
accepts an `onResolved` callback, fired once per round actually resolved,
threaded through from every caller that can observe a round go overdue — a
vote, a state poll, or the real-time layer's own proactive deadline timer;
and `public/index.html` switched its primary sync mechanism from
`setInterval(poll, 1200)` to an `EventSource` connection, with a slow 15-
second poll kept as a backstop. `spec/realtime.test.ts` was added in the same
commit: five tests run against the real running app (not a mock), covering
two-client propagation timing, tally/participation-leakage checks, duplicate
and simultaneous votes, reconnect recovery, and the empty-round/genuine-tie
distinction.

## What the review passes found and fixed

Before committing, the implementation went through a focused correctness
review against exactly the risk the design decision was meant to guard
against, plus the ordinary hazards of adding a long-lived connection to a
single-process Node server. Three real issues surfaced and were fixed in the
same commit, not left for later: first, the deadline timer and broadcast path
had no exception handling, so a single broken socket write could have thrown
out of a `setTimeout` callback and crashed the whole process — every
connection wrapped in try/catch so one bad client can only drop itself.
Second, a burst of overdue rounds resolving at once (realistic after Fly
stops the machine across more than one round's duration) would have fired one
broadcast per backlogged round; the hub now coalesces any number of
resolutions arriving before the next microtask into exactly one notification
and one timer rearm. Third, the browser's `EventSource` reconnecting after a
drop fired no resync on its own — `onopen` now triggers an immediate state
refetch, on both the first connection and every reconnect, which is what
actually makes reconnect recovery "immediate" rather than "eventually, next
poll." A fourth, smaller issue — overlapping `poll()` calls from the backstop
timer, the SSE event, and the round-deadline tick landing in the same window
and both deciding to show a round reveal — was fixed with an in-flight/queued
guard around `poll()` itself. The test suite was correspondingly strengthened
to check for exactly one resolution notification per round and for identical
SSE cadence between empty and populated rounds, so a participation signal
can't leak through event *timing* even though it can't leak through content
either.

## What's deliberately unverified

Two things are explicitly not claimed as done. No browser-automation tool
(Playwright, Puppeteer, or similar) is installed in this project, so
`spec/realtime.test.ts` verifies the server's HTTP/SSE contract directly —
exactly what a browser would receive on the wire — but does not drive
`public/index.html` through an actual browser; the frontend fixes were
checked by reading the script and by manually exercising the running app.
Second, whether Fly's proxy treats an open SSE connection as active traffic
for `auto_stop_machines` purposes has not been confirmed, because that can
only be observed against a real deployment and this round of work stopped
before deploying. Both gaps are recorded, not glossed over, in
`docs/adr/0002-sse-for-realtime-delivery.md`.

## The one documented multiplayer decision

`docs/adr/0001-hidden-votes-visible-outcomes.md` records the decision this
crit asked for: going real-time changed *when* a player learns a round
resolved, not *what* they're allowed to see while it's open. The alternative
of surfacing a live running tally, or even a content-free "someone just
voted" pulse, was considered and rejected, because either would let players
react to each other's choices instead of deciding independently — which is
the one thing C8's hidden-tally design was already built to prevent.
