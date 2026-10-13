# One Character, Many Players

One Character, Many Players is a small multiplayer game and, at the same
time, a small experiment in collective coordination: one shared character,
and everyone who opens the page votes on what it does next. No one controls
it alone, and now everyone sees the result at essentially the same moment.

## How a round works

Each round, every visitor can cast one vote: `LEFT`, `JUMP`, or `RIGHT`.
Votes are hidden while open — the server sends only whether *you* have
voted, never the tally, never who else is voting or how many. On close, a
unique majority action is applied (`LEFT`/`RIGHT` move the character, `JUMP`
toggles its level), and the full tally becomes visible to everyone at once. A
genuine tie — votes cast, but no unique top action — leaves the character
still, and is shown and kept in history. A round with zero votes resolves
internally so the next can open, but isn't shown as a tie or a failure:
nobody failed to coordinate, because nobody was there.

## Real-time, without revealing more

A change one player makes is designed to reach every other open tab within
about a second, with no reload: the server pushes a content-free "round
resolved" signal over Server-Sent Events, and each browser answers by
fetching its own authoritative state. That target is checked by automated
tests locally; it hasn't yet been deployed or confirmed in production. Speed
and content stay separate — going real-time didn't mean sending more. An open
round's tally stays exactly as hidden as before; only the moment of finding
out got faster. `docs/adr/` records that decision and the push channel's open
questions, including what only a real deployment can settle (Fly's auto-stop
behaviour with a long-lived connection open).

## What "good" means here

Good means making coordination visible, including failure to coordinate. A
clear majority, a real disagreement, and plain absence are three different
things, and players should be able to tell them apart from what happens to
the character and the round history — not disagreement hidden behind a
character that always moves somehow, and not "nobody voted" dressed up as
"we failed to agree." Arriving at that signal sooner doesn't change what the
signal is: the interesting question is still whether strangers who can't
talk can tell, from the outcome alone, whether they agreed, disagreed, or
weren't there.

## Why there's no chat, and no visible running count

There is deliberately no chat, voice, direct messaging, or reaction system,
and no visible count of votes-in-progress either, for the same reason: both
would let players react to each other instead of deciding independently, and
a visible running count turns "majority" into "whoever voted first and
loudest," not independent agreement.

## What the current build does

The server persists the character, every round, and every vote in SQLite —
the only authoritative state, surviving a restart or redeploy. Voters are
anonymous, identified only by a random cookie; one vote per voter per round
is enforced by a database constraint, not just application logic. Rounds
resolve against stored timestamps rather than a live timer alone, surviving
the process stopping between requests, with a proactive deadline timer as an
optimisation on top. The browser holds one SSE connection for push
notifications and keeps a slow polling backstop in case a connection stalls.

## Not built yet

The level itself — obstacles, branching paths, multiple valid routes to a
goal — doesn't exist yet; the world is still an open lane.

## Reference

The [course final project brief](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/final-project/)
describes what this submission is assessed against.
