# ADR 0001: Hidden votes, visible outcomes

## Status

Accepted, C9 (week 10).

## Context

C9 requires the app to behave correctly with several people using it at the
same moment, and requires one such multiplayer behaviour decision to be
written down with alternatives and trade-offs. Real-time delivery (ADR 0002)
makes it easy to push *more* information to open tabs than C8 ever sent — the
risk this decision addresses is that "more real-time" quietly becomes "show
the running vote count," which would undo a rule C8 already committed to.

## Decision

While a round is open, every connected player sees exactly the same two
things C8 already sent, now delivered the moment they're true instead of on
the next poll: the shared character's position/level, and whether *they*
personally have voted. No one — including the voter themselves — sees the
emerging tally, which action is ahead, or how many people have voted. The
real-time channel (`src/http/events.ts`) broadcasts one content-free signal,
`resolved`, with no action, count, or payload of any kind; every browser
receiving it re-fetches its own state from `GET /api/state`
(`src/api.ts`'s `buildStatePayload`), which is the one function allowed to
read tallies at all, and it only ever does so for *already-resolved* rounds
(`recentRounds`). The moment a round closes, its full tally and result become
visible to everyone, kept in the recent-rounds history.

**Simultaneous players**: every open tab votes independently through the
same `POST /api/vote`; `votes.UNIQUE(round_id, voter_id)` enforces one vote
per anonymous cookie-identity per round regardless of how many people submit
at once, and better-sqlite3's synchronous, single-threaded execution means
there is no window where two simultaneous votes can race each other.

**Genuine ties vs. empty rounds**: both resolve to the `TIE` result label
(`src/game/lifecycle.ts`'s `decideResult`), because neither has a unique
highest action — but the tally distinguishes them, and the UI treats them
differently. A real tie (e.g. one `LEFT`, one `RIGHT`) is shown and kept in
history; a round with zero votes is suppressed from the reveal and the
visible trace, because nobody failed to agree — nobody was there. This
distinction, established in C8, is untouched by the real-time layer: the
`resolved` event fires identically for both cases, so event *cadence* can't
leak which one just happened either.

**Disconnect / reconnect**: a dropped SSE connection loses no game state,
because none lives in it — it's a lossless pointer to "go check `/api/state`
again." On reconnect (including the browser's own automatic `EventSource`
retry), the client re-fetches full state immediately rather than replaying a
missed event log; this is simpler and more robust than event-sourcing, and
correct under the only recovery path there is here, since the SQLite
database is the single durable record.

## Alternatives considered

**Reveal a live running tally** (e.g. "LEFT 3 · JUMP 1 · RIGHT 2" updating as
votes land). More visually "live," but it directly reverses the reasoning
already recorded in `README.md`'s hidden-vote section: a visible count turns
independent agreement into "whoever voted first and loudest." Rejected.

**A content-light "someone just voted" pulse**, with no count or action.
Looks safer, but even an un-numbered pulse leaks a coarse participation
signal no part of C8's model exposes (an empty round would emit zero pulses,
distinguishable from any round with votes). Rejected for the same underlying
reason as the running tally, just milder.

**Status quo shape over a push channel (chosen)**: zero change to the
hidden-vote contract already defended in `README.md`, lowest risk to shipped
C8 behaviour, and it keeps the one signal this project is actually about —
whether strangers who can't talk coordinated, disagreed, or weren't there —
undamaged by moving to real time.

## Why this supports "what good means here"

`README.md` already states the standard this project holds itself to: making
coordination visible, including failure to coordinate, without letting a
visible tally turn majority into first-and-loudest. Real-time delivery is an
*infrastructure* improvement — it removes the up-to-1.2s-plus lag and
cold-start variance of C8's polling (see the C9 audit) — not a new feature
with its own data to expose. Speed and content are separate axes; this
decision keeps the content axis exactly where C8 left it while only changing
the speed axis.

## Consequence / accepted trade-off

The real-time channel's user-visible payoff is narrower than it could be — it
makes the game feel responsive rather than adding new drama — and that is
deliberate, not an oversight.
