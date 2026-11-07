# Harness for One Character, Many Players

## What this app is

A real-time multiplayer game where every visitor votes each round on a
shared character's direction (`UP`/`DOWN`/`LEFT`/`RIGHT`) through a ten-level
maze; a unique majority moves it, a genuine tie holds it still, and an empty
round is suppressed rather than shown as disagreement. Each visitor is an
anonymous cookie identity (C10), told apart from every other without
accounts, with server-side logs
recording who did what in a privacy-safe form. See `README.md` for the full
rules and `docs/adr/` for the C9 design decisions (hidden votes vs. visible
outcomes, and why SSE over WebSockets/polling) and the C10 decision
(anonymous cookie identity/authorization and pseudonymous logging).

## Non-negotiable invariants

These are load-bearing project decisions, not implementation details — don't
"simplify" past them without updating the relevant ADR first:

- **SQLite is the only authoritative state.** Character position/level,
  rounds, and votes all live in `src/db/`. Nothing in `src/http/events.ts`
  (the SSE layer) may hold or forward game state of its own — it broadcasts
  a content-free `resolved` signal only; see
  `docs/adr/0002-sse-for-realtime-delivery.md`.
- **Open-round tallies are never sent to anyone, including the voter who cast
  them.** Only `hasVoted` for *that* voter crosses the wire while a round is
  open. `src/api.ts`'s `buildStatePayload` is the one function allowed to
  read tallies at all, and it only does so for already-resolved rounds. See
  `docs/adr/0001-hidden-votes-visible-outcomes.md` before adding anything
  that surfaces live vote counts, participation counts, or who's "winning" —
  that's a reversal of a deliberate decision, not a bug fix.
- **One vote per voter per round**, enforced by `votes.UNIQUE(round_id,
  voter_id)` in `src/db/schema.ts`, not just application logic.
- **Empty rounds and genuine ties both resolve to `TIE`, but must stay
  visually distinguishable.** A real tie (votes cast, no unique winner) is
  shown and kept in history; a zero-vote round is excluded from the reveal
  and the visible trace. Don't collapse this distinction — it's the point of
  the project (see `README.md`'s "what good means here").
- **Round resolution must stay correct with no process running.** Fly can
  stop the machine between requests (`fly.toml`'s `auto_stop_machines`), so
  `ensureCurrentRound`'s lazy, timestamp-based resolution on the next request
  is the real correctness mechanism — the proactive SSE deadline timer is an
  optimization on top of it, never a replacement.
- **Identity is an anonymous `HttpOnly` cookie, never an account.**
  `src/http/voter.ts`'s `getOrCreateVoterId` is the only place a `voter_id`
  is minted or read; no endpoint may accept a client-supplied voter id (body
  field, query string, or header) as an alternative to the request's own
  cookie. See `docs/adr/0003-anonymous-identity-and-authorization.md` before
  adding login, passwords, or any form of account — the brief needs
  distinguishable browsers, not authenticated people, and accounts are a
  reversal of that decision, not a feature addition.
- **Server logs never carry a raw `voter_id`, full cookie, secret, or request
  body.** `src/logging.ts`'s `deriveLabel` is the only sanctioned way to name
  a player in a log line (a short HMAC-derived label, keyed by
  `VOTER_LABEL_SECRET` or a per-process fallback key); `logInternalError` is
  the only sanctioned way to log a caught exception (operation label + error
  type only, never `.message` or `.stack`). Don't add a `console.error(err)`
  or `console.log(voterId)` outside these two functions without checking
  whether the value being logged could carry a voter id.
- **`round.resolved` and any other log line exposing a tally may only log
  after a round's resolving transaction commits.** Same timing rule as
  `buildStatePayload`'s `recentRounds` — the log stream is not exempt from
  the hidden-open-round-tally rule above.

## Commands

- `pnpm dev` — run the server locally (`node --watch src/server.ts`).
- `pnpm typecheck` / `pnpm build` — both run `tsc --noEmit`.
- `pnpm test` — runs `spec/*.test.ts` against a **running** app; start the
  app first, or let `pnpm check` do both.
- `pnpm check` — typecheck + test; this is what CI runs.
- `pnpm check:evidence` — verifies PROCESS.md/reflections/CLAUDE.md are
  present and cited commits actually exist in this repo.

When testing locally, use an isolated `DATA_DIR` (e.g. a `mktemp -d`) rather
than the default `.data/` dev database, so ad hoc test runs don't disturb
whatever local state is there.

`VOTER_LABEL_SECRET` is optional and never required for correctness — unset,
player log labels are still stable within one process but change on every
restart. Setting it is a deploy-time decision (`flyctl secrets set
VOTER_LABEL_SECRET=<random value>`, never committed to `fly.toml` or any
tracked file), not something to default or generate in application code.

## Safe git / deployment workflow

- Never `git add -A` or `git add .` — this repo carries an untracked,
  off-limits `.astro/` directory (stale tooling cache from before the stack
  moved to plain `node:http`); stage files by exact path.
- Create new commits rather than amending; never rewrite history that's
  already been pushed.
- Never force-push, never push to `main` without being asked, and never flip
  repository visibility or trigger a deploy without explicit confirmation —
  `fly.toml`'s comments explain the one-machine, one-volume shape the course
  watches, and CI deploys automatically on every push to `main` once the repo
  is public.
- `fly.toml`, the `Dockerfile`, the CI workflow (`.github/workflows/`), and
  `spec/README.md` each document what they fix — read those before changing
  deploy-adjacent config, rather than guessing.
