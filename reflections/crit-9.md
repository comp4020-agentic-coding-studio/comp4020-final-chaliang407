# Crit 9 reflection

**What was the breakthrough that moved the work forward?**

Going real-time could easily have meant "send more" — a live vote count feels
like the obvious way to make a shared game feel alive. The breakthrough was
realizing speed and content are two separate axes, and C9 only asked me to
move one of them. The server-sent-events channel I built broadcasts literally
nothing — `data: {}` — and every client re-fetches its own hidden-tally-
respecting state afterward. That design choice came directly from re-reading
what C8 had already argued for in README.md: a visible running count turns
independent agreement into "whoever voted first and loudest." Real-time
delivery had to make the existing contract faster, not make a new, bigger
one. Writing `docs/adr/0001-hidden-votes-visible-outcomes.md` was where that
became explicit enough to defend, rather than just a feeling I had while
coding.

**What did this work change about who I want to be as a software developer?**

A focused correctness review before committing caught three real bugs — an
unguarded exception path that could crash the whole process on one broken
socket, a notification burst after a backlog of overdue rounds, and a
reconnect that didn't actually resync anything — none of which showed up by
just running the happy-path tests once. I want to keep treating "it passed"
and "I adversarially tried to break it" as two different, both-necessary
steps, especially for anything touching concurrency or a long-lived
connection, where the failure modes don't show up by accident.
