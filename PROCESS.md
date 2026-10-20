# Process overview: C8 → C10

## C8 → C9, summarized

C8 (preserved in git history at
[`b70751b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/b70751b35176ea5ab3a4d456fcc0a8f06dcbba0b))
left the app with SQLite persistence, anonymous voting, hidden open-round
tallies, and a browser that polled for state. C9 required a change one
person makes to reach every other open session within about a second, with
no reload, plus one documented multi-player decision.

A read-only audit came first: `POLL_MS = 1200` was usually fast, but a
bystander tab's poll was phase-unsynchronized with when a round actually
resolved, and `fly.toml`'s `auto_stop_machines` meant a poll could land on a
cold-starting machine with no bound on the delay. SSE was chosen over
WebSockets (no duplex need beyond the existing `POST /api/vote`) and over
faster polling (a smaller version of the same problem, not a fix).

The real-time layer landed in
[`a7fad4e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/a7fad4e6437ad1d458b172c8413dc7cdec2de36c):
`buildStatePayload` became the one place tallies can be read; `src/http/events.ts`
broadcasts a content-free `data: {}` "resolved" signal; `public/index.html`
switched to `EventSource` with a slow poll as backstop; `spec/realtime.test.ts`
covers propagation timing, leakage, duplicate votes, reconnect, and the
empty-round/genuine-tie distinction. A pre-commit review caught and fixed
three real issues in the same commit: unguarded exception paths that could
crash the process on one broken socket, a notification burst after a backlog
of overdue rounds, and a reconnect that resynced nothing on its own.
`docs/adr/0001-hidden-votes-visible-outcomes.md` and
`docs/adr/0002-sse-for-realtime-delivery.md` record the decision and its
open questions (notably, whether Fly's proxy treats an open SSE connection as
active traffic was left unconfirmed, since C9 wasn't deployed before its
cutoff).

## C10: identity, authorization, and logging

C10 adds a new axis: the server must tell two or more concurrent people
apart, enforce server-side what each may see or change, and log who did
what, so a crit presenter can narrate from Fly's logs while two classmates
act on the app from separate Chrome profiles. Unlike C9's new capability,
C10's job was mostly to make an *existing* decision — C8's anonymous
`voter_id` cookie — explicit, documented, and visible in logs, without
reopening the hidden-vote contract C9 had just finished defending.

**Read-only audit, again before any code.** `src/http/voter.ts`'s cookie
minting, `src/api.ts`'s `hasVoted` scoping, `src/db/votes.ts`'s uniqueness
constraint, `src/http/events.ts`'s connection handling, and every existing
`console.*` call site were read before anything was written. Conclusions:
two Chrome profiles already get distinct identities for free (each is its
own cookie jar, and `getOrCreateVoterId` only mints when no cookie arrives);
no endpoint accepts a client-supplied voter id anywhere, so there was no
existing spoofing surface to close; and the app had essentially no
structured operational logging — six `console.*` calls total, all startup
noise or raw exception dumps, none saying who voted, who connected, or what
a round resolved to. That gap, not an authorization hole, was the actual
target.

**Implementation and privacy-safe labelling.** `src/logging.ts` is new: one
structured JSON line per event, for identity creation, SSE connect/disconnect,
accepted/rejected votes (with reason), and round resolution (result, tally,
whether the character moved). The design question was how to name a player
in a log line without the log becoming a second copy of their voting
credential; `docs/adr/0003-anonymous-identity-and-authorization.md` records
the answer: `deriveLabel` HMACs the cookie under a server-only key
(`VOTER_LABEL_SECRET`, or a random per-process key if unset) and truncates
the digest — stable within a session, one-way, never the raw cookie.
`round.resolved` logs only after its transaction commits
(`src/game/lifecycle.ts`), the same timing rule `buildStatePayload` already
used, so the log stream can't become a new tally-leak channel. This landed in
[`0e5628c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/0e5628ccfab469b005939229fd969ff173fd2f11)
with `spec/identity.test.ts` and `spec/logging.test.ts`: the former drives the
real running app over HTTP to confirm two cookie jars get distinct identities,
duplicate votes are rejected per-cookie, `hasVoted` never leaks across
identities, and two concrete spoof attempts (a `voterId` field in the vote
body, a `voterId` query string on `/api/state`) do nothing; the latter checks
the logger's own output in-process, since the spec harness only reaches the
app over HTTP.

**The privacy-hardening review.** Before committing, a focused review checked
the diff for any error path that could leak a raw voter id, and found two:
`DuplicateVoteError`'s message interpolated the raw `voter_id`, unused by any
logger today but one careless future `console.error(err)` away from a leak;
and the three remaining generic `console.error(err)` catch-alls in
`src/api.ts`/`src/server.ts` would print such a message in full if that ever
changed. Both were fixed in
[`ae083a3`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/ae083a32ba27f92efa781295c54e00a22831a34f):
`DuplicateVoteError` now carries `roundId` as a typed property instead of
interpolating the voter id at all, and the catch-alls call a new
`logInternalError(operation, err)` that logs only a fixed operation label and
the error's `.name` — never `.message` or `.stack`. Two regression tests pin
this down: the error's message/stack never contain a voter id, and the 409
duplicate-vote response body is unchanged. The two C10 commits were kept
deliberately separate — identity/logging, then hardening — so the history
shows the audit finding and its fix as two legible steps, matching the
two-pass discipline (tests passing vs. an adversarial review) C9's reflection
already named as worth keeping.

**What's deliberately unverified.** As with C9's own gaps: this logging has
been built and tested against the real running app's HTTP/SSE surface and,
separately, the logger's own output in-process — but not yet exercised as a
live two-Chrome-profile session narrated from `fly logs`, and the app hasn't
been redeployed since C9. Configuring `VOTER_LABEL_SECRET` as a Fly secret,
so that a player's log label survives a machine auto-stop/restart rather than
changing with each new process, is also still pending — it requires a
deliberate `flyctl secrets set` step this round of work stopped short of,
rather than code. `reflections/crit-10.md` says the same.

## The documented decisions, together

`docs/adr/0001-hidden-votes-visible-outcomes.md` (C9) and
`docs/adr/0003-anonymous-identity-and-authorization.md` (C10) now cover
complementary halves of the same underlying model: who the server believes a
request is from, and what it will and won't show that identity. Neither
reopens the other — C10's identity work treats C9's hidden-tally rule as a
fixed constraint on its own logging design, not a decision available to
revisit.
