# Crit 7 reflection

The breakthrough this week wasn't in the code — it was noticing that green
tests and a clean `pnpm build` had already lied to me once. The room-booking
app passed every local check and built without complaint, and I still made
the agent prove it against a real Fly.io deployment before believing it
worked. It didn't: `better-sqlite3` had no native toolchain to compile
against on the actual build image, the server was silently binding to
localhost instead of `0.0.0.0`, and — once both of those were fixed —
cancelling a booking failed with a 403 the moment I tested it over the real
HTTPS URL instead of localhost. None of that showed up in `pnpm check` or a
local `pnpm start`. Each one only existed at the seam between my dev machine
and the actual deployment target.

That changed how I directed the agent for the rest of the week. I stopped
accepting "tests pass" or "should work" as a stopping point and started
treating every claim as a hypothesis to check against the running thing —
first the browser, then the real production URL, with the exact headers a
browser actually sends. The origin-check fix only made sense once I'd
reproduced the 403 myself against production, rather than trusting a
description of it.

What this changes about who I want to be as a developer: I don't treat "it
built" or "it's green" as evidence of anything beyond the environment they
ran in. Full-stack work has more seams than a static site did, and I want to
be the kind of developer who checks the seam, not the one who assumes the
parts add up.
