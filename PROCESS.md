# Process overview: C8 → the final project

## C8 → C9, summarized

C8 (preserved at
[`b70751b`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/b70751b35176ea5ab3a4d456fcc0a8f06dcbba0b))
left the app with SQLite persistence, anonymous voting, hidden open-round
tallies, and a browser that polled for state. C9 required a change one
person makes to reach every other open session within a second, with no
reload, plus one documented multi-player decision.

A read-only audit came first: `POLL_MS = 1200` was usually fast, but a
bystander's poll was phase-unsynchronized with resolution, and
`auto_stop_machines` meant a poll could land on a cold-starting machine with
no bound on delay. SSE was chosen over WebSockets (no duplex need beyond
`POST /api/vote`) and over faster polling (a smaller version of the same
problem). The real-time layer landed in
[`a7fad4e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/a7fad4e6437ad1d458b172c8413dc7cdec2de36c):
`buildStatePayload` is the one place tallies can be read; `src/http/events.ts`
broadcasts a content-free `data: {}` signal; `spec/realtime.test.ts` covers
timing, leakage, reconnect, and the empty-round/tie distinction.

## C10: identity, authorization, and logging

C10 added an anonymous `voter_id` cookie's visibility in logs and its status
as the authorization boundary. `src/logging.ts` (`deriveLabel`, HMAC-based,
never the raw cookie) landed in
[`0e5628c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/0e5628ccfab469b005939229fd969ff173fd2f11),
and a follow-up pass in
[`ae083a3`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/ae083a32ba27f92efa781295c54e00a22831a34f)
removed a raw `voter_id` from an error message and introduced
`logInternalError` (operation label + error type only).

## The final project: from one open lane to a ten-level maze

The brief's "good, full-stack, multi-user app" needed more than one shared
position — the hidden-vote/anonymous-identity/real-time foundation was
sound, but there was no level, no stakes, nothing to disagree *about*. The
final project built that on top.

**Why the stack stayed plain `node:http` + TypeScript + `better-sqlite3`.**
C8's rationale — no framework until the shared-state problem was understood
— still held at ten mazes: a bigger game is more rows of the same
`x`/`y`/`level` state, not a new request-lifecycle shape, and nothing about
ten levels needed routing beyond the five endpoints already there.
`better-sqlite3`'s synchronous transactions let a round's player move, enemy
move, pellet pickup, and collision check commit together with no
interleaving window — a framework's async pipeline would have had to be
worked around to get that back, not bought it for free.

**The agentic workflow: scoped milestones, gated approval, isolated
verification.** Each milestone — levels/migration, pellets, progression,
enemies, frontend integration, then the hybrid enemy AI — was proposed and
explicitly approved before being built, never started ahead of approval, so
scope stayed bounded instead of growing mid-task. Every milestone's testing
ran against a throwaway `mktemp -d` database via `DATA_DIR`, never the local
dev or a deployed database, so iterating on the hybrid AI could not corrupt
local state or touch production. Browser verification (Playwright, headless
Chromium) ran against one of those throwaway-DB servers too, before anything
was reported done. Local commits stayed separate from pushing or deploying:
work landed on this branch and was reported for review before any `git
push`, so nothing reached the deployed app mid-iteration.

**Milestones 1–2: ten validated levels, non-destructive migration.** Ten
fixed maze layouts (`src/game/levels.ts`), checked by a shared validator
(`src/game/mazeValidator.ts`) for full connectivity, a dead end, an
intersection, a cycle, and two distinct route lengths — C8's hand-verified
standard, now automated across all ten (`spec/levels.test.ts`). The database
shape changed from 1D `position`/`level` to 2D `x`/`y` plus `level`/`score`,
with no lossless mapping from the old shape — the old
`character`/`rounds`/`votes` tables are archived by rename
(`*_legacy_pre_maze`) rather than dropped, and `level`/`score` added via
`ALTER TABLE`, with a snapshot table preserving the pre-migration character
row. A pre-migration `won=1` meant "reached the old maze's exit," not
"completed ten levels," so it's reset to `0` and logged, never carried
forward as a false victory
(`spec/migration.test.ts`, `spec/levelsMigration.test.ts`).

**Milestone 3: pellets and scoring.** Server-authoritative pellet collection,
guarded by one `UPDATE ... WHERE collected = 0` so a tile can't be
double-scored, wired into the same transaction that moves the character
(`spec/pellets.test.ts`).

**Milestone 4: level progression, victory, restart.** Reaching a level's EXIT
advances to the next level's START (or sets final victory at level 10);
Restart Game resets level, score, every pellet, and every enemy to spawn, all
in one transaction, so a crash partway through can't leave a half-reset game
(`spec/levelProgression.test.ts`).

**Milestone 5: enemies and collisions, later made hybrid.** Enemies move one
walkable tile per round via an injectable `rng` (default `Math.random`),
letting `spec/collision.test.ts` assert an exact forced collision rather
than retrying real randomness. A collision costs 20 points (floored at
zero) and overrides any level transition that round. Movement was later
upgraded from uniform random to a hybrid AI (`src/game/enemies.ts`):
`CHASE_CHANCE = 0.7` of each enemy's draw takes a BFS shortest-path step
toward the player's pre-move position, respecting walls; the rest patrol a
random neighbor — one draw per enemy either way, so the existing
deterministic-test contract needed no second draw. Testing without flakiness
took two passes: a seeded `mulberry32` PRNG with offline-verified
collision-free seeds replaced `spec/levelProgression.test.ts`'s
retry-until-lucky walks, then, once chasing invalidated those seeds' odds,
they were re-derived against the hybrid AI the same way.

**Milestone 6: frontend integration, and two real bugs caught by browser
verification.** `public/index.html` renders from `/api/state`'s own
per-level `maze`, with pellets, an enemy ghost, a HUD, and an event banner
for server-confirmed collisions and transitions — needed because the state
response couldn't distinguish "moved" from "got hit," so two new `rounds`
columns (`collided`, `advanced_level`) were added, written only after a
round's resolving transaction commits, the timing rule already governing
tally exposure. Browser verification (Playwright, headless Chromium,
screenshots down to 320px) caught a real defect before shipping: the round
completing level 10 also sets `advancedLevel = true`, so the frontend was
about to show "LEVEL 10 UNLOCKED" at the moment the player actually
won — fixed by only announcing an advance when the game isn't also won that
round. A second gap surfaced on review: the enemy-sync test accepted
unchanged positions as passing, which movement being silently broken would
also satisfy; it now asserts each enemy's position actually differs from its
pre-round one.

## What's deliberately unverified

As with C9 and C10's own gaps: the ten-level build has been exercised against
a running app over HTTP/SSE and a real headless browser, but not yet against
the *deployed* Fly app, which — as of this writing — still serves the
pre-maze build; `VOTER_LABEL_SECRET` also remains unset as a Fly secret, so
player log labels reset on every machine restart in production. Both are
next steps, not oversights.
