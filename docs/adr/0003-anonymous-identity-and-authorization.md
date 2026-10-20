# ADR 0003: Anonymous cookie identity and authorization, with pseudonymous logs

## Status

Accepted, C10 (week 11).

## Context

C10 requires the app to tell two or more concurrent people apart, enforce
server-side what each may see or change, and log who did what so a presenter
can narrate from logs rather than the UI. C8 and C9 already gave every
browser an anonymous `voter_id` cookie (`src/http/voter.ts`) and kept vote
tallies hidden while a round is open (ADR 0001); C10's job is to make that
existing identity *visible in logs* and *explicit as an authorization
boundary*, without reopening either of those earlier decisions.

## Decision

**No accounts.** C10 does not add login, passwords, usernames, or any
persistent record tying a browser to a real person. `getOrCreateVoterId`
mints a random UUID into an `HttpOnly; SameSite=Lax` cookie on first contact
and reuses it afterward; that cookie *is* the identity, exactly as in C8/C9.
Accounts were rejected because nothing in the brief asks the app to recognize
the same *person* across devices or sessions — only to tell concurrent
*browsers* apart during one sitting — and accounts would add a persistence
and privacy surface (credentials, password reset, a users table) to solve a
problem this app doesn't have.

**Two Chrome profiles get distinct identities for free.** A Chrome profile is
its own cookie jar; `getOrCreateVoterId` reads whatever `voter_id` cookie
arrived with the request, and only mints a new one when none is present
(`src/http/voter.ts`). Two profiles making their first request each receive a
cookie from an independent `randomUUID()` call, so they are distinguished by
ordinary cookie isolation, not by any new C10 mechanism. The same follows for
private/incognito windows and for clearing cookies: each gets a fresh
identity, which is correct for "anonymous per browser," not a bug to patch
around for the crit.

**What each player may see and change.** A request's own cookie is the only
input that selects whose state it reads or writes — `buildStatePayload`
(`src/api.ts`) computes `hasVoted` from the calling request's `voterId` alone,
never from a client-supplied id; `POST /api/vote` similarly records the vote
under the cookie's `voterId`, not any field in the request body. There is no
query parameter, header, or body field anywhere in the API surface that lets
one identity act as, or read as, another. A player may: see the shared
character's position/level, see whether *they* have voted this round, see
every resolved round's full tally and result, and cast exactly one vote per
open round. A player may not: see another identity's `hasVoted`, see any
tally for the still-open round (not even their own), or cast a second vote in
a round they already voted in.

**One vote per cookie per round**, enforced at the database layer —
`votes.UNIQUE(round_id, voter_id)` (`src/db/schema.ts`) — not only in
application code, so the guarantee holds even if a future code path forgets
to check first. `recordVote` (`src/db/votes.ts`) turns the constraint
violation into a typed `DuplicateVoteError`, which `POST /api/vote`
(`src/api.ts`) answers with `409`.

**`hasVoted` is private per identity** because it is computed from, and only
exposed to, the request's own cookie (`src/api.ts`'s `buildStatePayload`) —
the same mechanism that makes one identity's vote unreadable to another also
makes their lock state unreadable to another, by construction rather than by
a separate check.

**Open-round tallies stay hidden.** C10 changes nothing here: ADR 0001's
rule — no one, including the voter, sees a running count while a round is
open — is untouched. The new server logs introduced in C10 (`src/logging.ts`)
deliberately respect the same timing rule: `round.resolved` is only ever
logged after a round's resolving transaction has committed
(`src/game/lifecycle.ts`'s `resolveRound`), so the log stream itself cannot
become a second channel for leaking an in-progress tally.

**Why pseudonymous HMAC labels, not raw voter IDs, in logs.** A `voter_id` is
already an opaque UUID, but it is also the exact bearer value that
authenticates a vote — logging it verbatim would mean every operator or log
viewer who can read `vote.accepted`/`vote.rejected` lines effectively holds
the bearer credential for that identity too, and could forge requests as that
voter. `src/logging.ts`'s `deriveLabel` instead computes
`HMAC-SHA256(key, voterId).slice(0, 10)`: stable (the same cookie always maps
to the same label, so a presenter can narrate "player `a1b2c3d4e5` just
voted" across a whole log stream) and one-way (the label cannot be inverted
back to the cookie without the key, and the key itself is never logged). The
key is `VOTER_LABEL_SECRET` if an operator sets it, or a random per-process
key generated at startup otherwise — the latter keeps labels stable for one
continuous session but not across a restart, which is an accepted trade-off
for a crit demo and is logged explicitly (`logging.ephemeral_label_key`) so
it's never a silent surprise.

## Limitations

**Cookie possession is the only credential.** `voter_id` is a bearer token:
whoever holds the exact cookie value can vote as that identity, with no
second factor. `HttpOnly` stops ordinary in-page JavaScript from reading it,
but a tool that can set arbitrary request headers (`curl`, a proxy, dev
tools) can still impersonate an identity whose cookie it has obtained by some
other means. This is accepted because the brief asks for distinguishable
*browsers*, not unforgeable *people* — a stronger guarantee would need real
authentication, which accounts were explicitly rejected to avoid.

**Multiple browser profiles under one person's control are indistinguishable
from multiple people.** The server has no way to know that two cookies
belong to the same human running two Chrome profiles rather than two
different humans — and by design shouldn't try to: identity here is
intentionally "one vote-eligible slot per browser," not "one slot per
person." A player who wants more influence can open more profiles; this is
the same limitation C8's anonymous-cookie model always had, not something C10
introduces or needs to solve.

**Clearing cookies resets identity.** A returning player who clears cookies,
or whose browser does so automatically, gets a new `voter_id` and a clean
`hasVoted` state — expected, not a defect, for a system with no accounts to
recognize them by.

## Alternatives considered

**Lightweight accounts (username only, no password).** Would let the server
tell *returning people* apart across sessions, which nothing in the brief
asks for, at the cost of a persistence surface (a users table, session
expiry policy) this app doesn't otherwise need. Rejected.

**IP-address-based identity.** Trivially defeated by NAT/shared networks
(exactly the two-Chrome-profiles-on-one-laptop demo scenario this crit
requires), and would log a real-world network identifier — the opposite of
the privacy-safe labelling this ADR argues for. Rejected.

**Logging raw `voter_id` values, relying on log-access controls for
privacy.** Simpler, but makes every log reader a de facto holder of a voting
credential, and Fly's log retention means that exposure outlives any given
session. Rejected in favor of the one-way HMAC label.

## Consequence

Authorization in this app is, and remains after C10, "possession of a
specific anonymous cookie, checked against the one row of state that cookie
is allowed to touch" — nothing more is claimed, and nothing more was added.
C10's contribution is making that boundary explicit in writing and making the
server's own behavior narratable from logs, not changing where the boundary
sits.
