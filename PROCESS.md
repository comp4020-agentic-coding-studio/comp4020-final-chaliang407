# Process overview: C8 → the final project

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
faster polling (a smaller version of the same problem, not a fix). The
real-time layer landed in
[`a7fad4e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/a7fad4e6437ad1d458b172c8413dc7cdec2de36c):
`buildStatePayload` became the one place tallies can be read; `src/http/events.ts`
broadcasts a content-free `data: {}` "resolved" signal; `spec/realtime.test.ts`
covers propagation timing, leakage, duplicate votes, reconnect, and the
empty-round/genuine-tie distinction.

## C10: identity, authorization, and logging

C10 added an anonymous `voter_id` cookie's visibility in logs and its
explicit status as the authorization boundary. `src/logging.ts`
(`deriveLabel`, HMAC-based, never the raw cookie) landed in
[`0e5628c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/0e5628ccfab469b005939229fd969ff173fd2f11),
and a follow-up privacy-hardening pass in
[`ae083a3`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/ae083a32ba27f92efa781295c54e00a22831a34f)
removed a raw `voter_id` from `DuplicateVoteError`'s message and introduced
`logInternalError` (operation label + error type only). `docs/adr/0001` and
`docs/adr/0003` record the C9/C10 decisions; `reflections/crit-{8,9,10}.md`
cover each week's own breakthrough and gap.

## The final project: from one open lane to a ten-level maze

The brief's "good, full-stack, multi-user app" needed more than a lane with
one shared position — the existing hidden-vote/anonymous-identity/real-time
foundation was sound, but there was no level, no stakes, nothing to disagree
*about*. The final project built that on top, milestone by milestone, each
one scoped and approved before implementation, so scope stayed bounded
rather than growing mid-task.

**Milestones 1–2: ten validated levels, non-destructive migration.** Ten
fixed maze layouts (`src/game/levels.ts`), each larger than the last, each
checked by a shared validator (`src/game/mazeValidator.ts`) for full floor
connectivity, at least one dead end and one intersection, a genuine cycle,
and at least two distinct start-to-exit route lengths — the same standard
C8's own hand-verified maze met, now automated and applied to all ten
(`spec/levels.test.ts`). The database shape changed from a 1D
`position`/`level` pair to 2D `x`/`y` plus `level`/`score`, which has no
lossless mapping from the old shape — rather than lose history, the old
`character`/`rounds`/`votes` tables are archived by rename
(`*_legacy_pre_maze`) inside one transaction, and the newer `level`/`score`
columns are added additively via `ALTER TABLE` on top of that, with a
snapshot table preserving the exact pre-migration character row. A
pre-migration `won=1` meant "reached the old single maze's exit," not
"completed ten levels," so that one value is explicitly reset to `0` and
logged, never silently carried forward as a false victory
(`spec/migration.test.ts`, `spec/levelsMigration.test.ts`).

**Milestone 3: pellets and scoring.** Server-authoritative pellet collection,
guarded by one `UPDATE ... WHERE collected = 0` so a tile can't be
double-scored, wired into the same transaction that already moves the
character (`spec/pellets.test.ts`).

**Milestone 4: level progression, victory, restart.** Reaching a level's EXIT
advances to the next level's START (or sets final victory at level 10);
Restart Game resets level, score, every level's pellets, and every enemy
back to spawn, all inside one transaction, so a crash partway through can't
leave a half-reset game (`spec/levelProgression.test.ts`).

**Milestone 5: enemies and collisions.** Enemies move one random walkable
tile per resolved round via an injectable `rng` (defaulting to
`Math.random`), which is what let `spec/collision.test.ts` assert an exact
forced collision rather than retrying real randomness until one happened. A
collision costs 20 points (floored at zero) and overrides any level
transition that same round. Testing random movement without flakiness took a
second pass: `spec/levelProgression.test.ts`'s level-advance tests originally
retried real random walks until they happened to avoid every enemy, which
could in principle still flake; they were rewritten to use a small seeded
PRNG (`mulberry32`) with per-level seeds verified offline to be
collision-free, removing the retry loop entirely.

**Milestone 6: frontend integration, and a real bug caught by browser
verification.** `public/index.html`'s maze now renders from `/api/state`'s
own per-level `maze` field rather than the old single-maze endpoint, with
pellets, enemies, a HUD, and an event banner for server-confirmed collisions
and level transitions — added because the existing `/api/state` had no
public signal distinguishing "the character moved" from "the character got
hit," so two new `rounds` columns (`collided`, `advanced_level`) were added,
written only after a round's resolving transaction commits, the same timing
rule already governing tally exposure. Browser verification (Playwright,
headless Chromium, screenshots at desktop and mobile widths down to 320px)
caught a real defect before it shipped: the round that completes level 10
also sets `advancedLevel = true` (the same flag an ordinary 1→2 transition
sets), so the frontend was about to show a "LEVEL 10 UNLOCKED" banner at the
exact moment the player actually won. Fixed by only announcing an advance
when the game isn't also won by that same round. A second gap surfaced on
review: the real-app enemy-sync test checked that positions matched across
two clients and that the enemy count was unchanged, both of which would
still pass even if enemy movement were silently broken; it now asserts
directly that each enemy's position differs from its pre-round position,
which the production movement rule guarantees whenever enemies actually move.

## What's deliberately unverified

As with C9 and C10's own gaps: the ten-level build has been exercised
against a running app over HTTP/SSE and in a real headless browser, but not
yet against the *deployed* Fly app, which — as of this writing — is still
serving the pre-maze build; `VOTER_LABEL_SECRET` also remains unset as a Fly
secret, so player log labels still reset on every machine restart in
production. Both are next steps, not oversights.
