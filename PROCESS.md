# Process overview

This is the C8 state of One Character, Many Players: a stranger can visit the
deployed app, vote, and find their trace still there later. Everything below
is the actual path from the brief to that point, not a feature list.

## Stack: minimal, before the shared-state problem was understood

I started from a deliberately small stack rather than bringing in a larger
framework before I understood what the shared-state problem actually
required:
[`1e7cfdf`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/1e7cfdf5e5ee8f09b35e1c0513918754848f31aa)
scaffolds a plain `node:http` server, run directly as TypeScript, with no
Express, no bundler, no Astro. The brief's core mechanic — one shared
character, votes hidden until a round closes, a majority or a tie — doesn't
need routing middleware or a templating layer; it needs correct state and a
correct resolution rule. Adding a framework first would have meant designing
around its request lifecycle before I knew what the lifecycle actually had
to do.

## Persistence came before gameplay, not after

The brief requires state that survives a session, a restart, or a redeploy,
and Fly's own machine model makes that non-negotiable rather than a nice-to-
have: this app's machine can stop between requests. So persistence came
early, not as a later addition bolted onto a working prototype:
[`4a4b4b0`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/4a4b4b0004d92eb92094341e4630a2179f13aa23)
adds the SQLite schema and the `character`/`rounds`/`votes` tables on the Fly
volume, before any voting logic exists to use them. The trade-off I accepted
was no in-memory shortcut at all during early development, even though
nothing yet depended on surviving a restart — I'd rather the storage model be
right from the first commit than retrofit it once gameplay already assumed a
live process.

## The voting lifecycle is where the brief's actual constraints live

[`982ca36`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/982ca361ca398b4a2a80767afb701509d93b3592)
is the commit that encodes the project's real rules, not just its plumbing:
anonymous voter identity in a cookie, one vote per voter per round enforced
by a database constraint rather than application logic alone, hidden tallies
for the open round (the state endpoint only ever tells a voter whether *they*
voted, never the count), a unique majority executing the action, and a tie
leaving the character still. Resolution is lazy — computed from stored
timestamps the next time any request arrives — rather than a timer, because
a timer would simply be lost whenever the machine stops. This is the one
decision in the project I'd defend hardest: it means the core mechanic has no
dependency on the process staying alive, which the stack choice above assumed
and this commit then actually had to deliver on.

## Building the interface exposed problems the API alone didn't

The playable UI went on top of that lifecycle once it existed, not before.
Manual inspection of the running app — not a design decided in advance — is
what shaped the rest of the work. First, the result reveal was too visually
dominant: it held the screen for about four seconds and obscured the shared
world it was supposed to be revealing something about, so I shortened it to
roughly 1.2 seconds. Second, and more importantly, the same inspection
surfaced a semantic bug, not a cosmetic one: a round with zero votes cast was
being shown exactly like a real tie — "No majority — TIE" — which misrepresents
absence as disagreement. I corrected this so a zero-vote round still resolves
internally (the lifecycle keeps rolling forward) but produces no reveal and
is excluded from the visible round history, while a genuine tie — votes cast,
no unique majority, e.g. one LEFT and one RIGHT — still shows and is kept.
Both of these were local iterations before anything was committed;
[`e756602`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/e756602328bd3fac3a59aa429d1207ed427cda71)
is the single commit that carries the corrected end state, not a record of
the intermediate, wrong one. I'm being explicit about that here because the
commit history alone would only show the fix existing, not the mistake it
replaced.

## What that bug sharpened

Distinguishing an empty round from a real tie forced a clearer answer to what
this project is actually for. If a tie looked like a bug, or silence looked
like conflict, the one signal the project depends on — whether strangers who
can't talk to each other coordinated, disagreed, or simply weren't there —
would be lost. That's the reasoning behind the definition
[`fbb8a08`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/fbb8a084b1662b05871fb17055b74e2813a0e22f)
records in `README.md`: good means making coordination visible, including
failure to coordinate. It wasn't a definition I had before writing the game;
it's a definition the empty-round/tie distinction made necessary.

## Verifying persistence for real

Before treating the persistence model as done, I verified it directly rather
than inferring it from the code: cast a vote that produced a meaningful,
distinguishable character-state change, killed the running server process,
restarted it with the ordinary `pnpm start` command, and confirmed the state
was unchanged on the first request afterward — including a round that had
become due while the process was down resolving itself lazily, exactly as
designed, with no timer to have lost. I then cast a further vote to confirm
the app kept working normally, not just that it remembered something static.
This checks the mechanism built in
[`4a4b4b0`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/4a4b4b0004d92eb92094341e4630a2179f13aa23)
and
[`982ca36`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-chaliang407/commit/982ca361ca398b4a2a80767afb701509d93b3592);
it isn't itself a commit, so there's nothing to cite for the verification
step beyond the mechanism it tested.

## What C8 deliberately doesn't claim

This is proof of life, not the finished project. The browser polls for state
rather than receiving a push; WebSockets or server-sent events aren't built,
and polling is a known, temporary stand-in. There is no level yet — no
obstacles, no branching paths, no points where LEFT, JUMP, and RIGHT are
different reasonable strategies rather than just movement. The actions move
a character along an open lane; making them strategically meaningful is
later work, not something already shipped.
