# One Character, Many Players

One Character, Many Players is a small multiplayer game and, at the same
time, a small experiment in collective coordination: one shared character,
and everyone who opens the page votes on what it does next. No one controls
it alone.

## How a round works

Each round, every visitor can cast one vote: `LEFT`, `JUMP`, or `RIGHT`.
Votes are hidden while open — the server sends only whether *you* have
voted, never the tally. On close, a unique majority action is applied
(`LEFT`/`RIGHT` move the character, `JUMP` toggles its level). A genuine
tie — votes cast, but no unique top action — leaves the character still,
and is shown and kept in history. A round with zero votes resolves
internally so the next can open, but isn't shown as a tie or a failure:
nobody failed to coordinate, because nobody was there.

## What "good" means here

Good means making coordination visible, including failure to coordinate. A
clear majority, a real disagreement, and plain absence are three different
things, and players should be able to tell them apart from what happens to
the character and the round history — not disagreement hidden behind a
character that always moves somehow, and not "nobody voted" dressed up as
"we failed to agree." The interesting question isn't where the character
ends up; it's whether strangers who can't talk can tell, from the outcome
alone, whether they agreed, disagreed, or weren't there. If ties looked like
bugs, or empty rounds like conflict, that signal would be lost.

## Why there's no chat

There is deliberately no chat, voice, direct messaging, or reaction system.
If players could tell each other what to pick, coordination would happen in
the messaging box, not through the shared character — and this project is
about what people do when the only channel between them is the consequence
they all cause together. Hiding the tally serves the same end: a visible
running count turns "majority" into "whoever voted first and loudest," not
independent agreement.

## What the current build actually does

The server persists the character's position/level, every round, and every
vote in SQLite, so state survives a restart. Voters are anonymous,
identified only by a random id in a cookie. The database enforces one vote
per voter per round via a `UNIQUE(round_id, voter_id)` constraint, not just
application logic. Rounds resolve lazily on the next request, against
stored timestamps rather than a live timer, so this survives the process
stopping between requests. The browser polls the server for state — no push
channel yet — and shows the shared character, the open round's countdown,
three real, keyboard-operable buttons that lock once you've voted, a brief
result reveal, and a short history of recent rounds that actually had
votes. Reduced-motion preferences are respected.

## Enforced vs. judged by playing

The implementation enforces one vote per voter per round, hidden open-round
tallies, persistence across restarts, and the majority/tie/empty-round
distinction above. What it can't enforce, and has to be judged by playing
it with other people, is whether the outcome *feels* like coordination
rather than noise.

## Not built yet

The level itself — obstacles, branching paths, multiple valid routes to a
goal, and points where `LEFT`/`JUMP`/`RIGHT` are different reasonable
strategies rather than just movement — doesn't exist yet. The world is
currently an open lane: the actions are directionally, not yet
strategically, meaningful. Live, same-moment updates between open tabs
(WebSockets or server-sent events) also aren't built; polling is a known,
temporary stand-in.

## Reference

The [course final project brief](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/final-project/)
describes what this submission is assessed against.
