# The Collective Maze

The Collective Maze is a multiplayer game and a small experiment in
collective coordination: one shared explorer, ten maze levels, and everyone
who opens the page votes on what it does next. No one controls it alone —
what's interesting isn't whether the crowd reaches EXIT, it's whether
strangers who can't talk can tell, from the outcome alone, whether they
agreed, disagreed, or weren't there.

## How a round works

Every three seconds, every visitor can cast one vote: `UP`, `DOWN`, `LEFT`,
or `RIGHT`. Votes are hidden while open — the server sends only whether
*you* have voted, never the tally, for the same reason there's no chat: either
would let players react to each other instead of deciding independently. On
close, a unique majority action moves the shared explorer one tile; a genuine
tie (votes cast, no unique winner) leaves it still, shown and kept in
history; a round with zero votes resolves internally but isn't shown as a
tie, since nobody failed to coordinate — nobody was there.

## Ten levels, pellets, enemies, and score

Ten hand-validated mazes, each larger than the last, each with at least two
distinct routes from START to EXIT so there's a real choice to disagree
about. Every level scatters a handful of collectible pellets (+10 points
each, optional — EXIT never requires collecting them all) and, from level 3
on, enemies that mostly hunt: each move, 70% of the time an enemy takes the
shortest legal path toward the explorer, and 30% of the time it wanders to a
random legal tile instead. A collision costs 20 points (floored at zero)
and resets the explorer to that level's START, overriding any level
transition that round. Reaching EXIT with no collision advances to the next
level's START; reaching level 10's EXIT is final victory, after which any
player can trigger Restart Game — a full reset of level, score, pellets, and
enemies, all in one atomic step.

## Multi-user, real-time, persistent

Two browsers (or two Chrome profiles) are told apart automatically by an
anonymous `HttpOnly` cookie — no accounts, no usernames. SQLite is the only
authoritative state: character position, level, score, every round, and
every vote survive a restart or a redeploy, and a database constraint (not
just application code) enforces one vote per voter per round. A change one
player makes reaches every other open tab within about a second: the server
pushes a content-free "something resolved" signal over Server-Sent Events,
and each browser fetches its own authoritative state in response — going
real-time never meant sending more, so an open round's tally, and the
positions enemies will move to, stay exactly as hidden as before they're
decided.

## What "good" means here

Good means making coordination visible, including failure to coordinate — a
clear majority, a real disagreement, and plain absence should stay tellable
apart, now across a ten-level game with its own scoring and hazards, not just
a single open lane. The game enforces, and tests check: one vote per voter
per round, hidden open-round tallies, the majority/tie/empty-round
distinction, and that collision/level-transition announcements come from a
server-recorded fact, never guessed from a score delta. What has to be judged
by playing it with others: whether reaching EXIT together, pellets and
enemies included, still feels like *coordination*, not just one lucky vote
after another.

## Reference

The [course final project brief](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/final-project/)
describes what this submission is assessed against.
