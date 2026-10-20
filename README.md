# One Character, Many Players

One Character, Many Players is a small multiplayer game and a small
experiment in collective coordination: one shared character, and everyone who
opens the page votes on what it does next. Good means making coordination
visible, including failure to coordinate — a clear majority, a real
disagreement, and plain absence should be tellable apart.

## How a round works

Each round, every visitor can cast one vote: `LEFT`, `JUMP`, or `RIGHT`.
Votes are hidden while open — the server sends only whether *you* have
voted, never the tally, for the same reason there's no chat or reaction
system: either would let players react to each other instead of deciding
independently. On close, a unique majority action is applied (`LEFT`/`RIGHT`
move the character, `JUMP` toggles its level), and the full tally becomes
visible to everyone. A genuine tie — votes cast, no unique top action —
leaves the character still, shown and kept in history. A round with zero
votes resolves internally so the next can open, but isn't shown as a tie:
nobody failed to coordinate, because nobody was there.

## Real-time, without revealing more

A change one player makes reaches every other open tab within about a
second, with no reload: the server pushes a content-free "round resolved"
signal over Server-Sent Events, and each browser fetches its own
authoritative state in response. Going real-time didn't mean sending more —
an open round's tally stays exactly as hidden as before.

## Two independent players, one shared character

Open the public URL in two separate browsers, or two Chrome profiles (what a
crit demo uses), and each is told apart automatically: a first request with
no `voter_id` cookie gets a fresh random one (`HttpOnly`, unreadable to page
JavaScript), reused on every later request from that profile. No sign-up, no
username — the cookie is each identity's whole credential, used for one
thing: enforcing one vote per cookie per round, and reporting `hasVoted` back
only to the cookie that cast it. Neither player can see or change the other's
vote or lock state. `docs/adr/0003-anonymous-identity-and-authorization.md`
explains why an anonymous cookie is enough here and its limits: it identifies
a browser, not a person, and clearing cookies starts a new identity, by
design.

## What the current build does

The server persists the character, every round, and every vote in SQLite —
the only authoritative state. One vote per voter per round is enforced by a
database constraint. Rounds resolve against stored timestamps, surviving the
process stopping between requests. The browser holds one SSE connection for
push notifications and a slow polling backstop.

Every meaningful server action — identity creation, a vote accepted or
rejected (and why), an SSE connection opening or closing, a round resolving
(result, tally, whether the character moved) — is written to stdout as one
structured JSON line, which Fly captures as logs. Each line names the player
by a short label derived from their cookie with a keyed HMAC, never the
cookie itself, so logs show who did what without becoming a second copy of
anyone's voting credential. `fly logs -a <app-name>` tails them live — what a
crit presenter reads while two players act on the same app. This logging is
built and tested locally; it hasn't yet been exercised against a real
two-browser session on the deployed app.

## Not built yet

The level itself — obstacles, branching paths, multiple valid routes to a
goal — doesn't exist yet; the world is still an open lane.

## Reference

The [course final project brief](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/final-project/)
describes what this submission is assessed against.
