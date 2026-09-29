# Working rules for this repo

These are the rules I've been holding the agent to. They're deliberately
narrow — this is a small, single-flow app, and the risk is scope creep, not
under-building.

- **Small, explicitly-scoped iterations.** Work happens one directed
  iteration at a time ("iteration N: do exactly this"), never an open-ended
  "keep improving this." A fix or a polish pass doesn't expand into new
  features just because the agent is already in the file.
- **Explain before editing, on anything non-trivial.** Before a substantial
  change, state what's about to change and why, so scope or direction issues
  get caught before the diff exists, not after.
- **Report concretely after editing.** After a change: which files changed,
  what actually changed (behaviour vs. appearance), whether backend/API
  behaviour changed at all, and the real output of `pnpm typecheck`,
  `pnpm build`, and the test suite — not an assumed "should pass."
- **Never commit, push, deploy, or make the repo public without being told to
  in that turn.** A prior approval doesn't carry forward to the next change.
- **Verify against the running app, not just unit assertions.** Before
  claiming persistence, validation, overlap rejection, or cancellation works,
  run it against a live built server (`pnpm build && pnpm start`, then
  exercise the API or page), in addition to `pnpm check`.
- **`README.md`, `PROCESS.md`, and `reflections/` are edited only when asked
  directly**, so those files reflect what was actually reviewed rather than
  what the agent chose to narrate along the way. `reflections/` in particular
  only ever takes the exact filenames the cutoff sweep reads
  (`reflections/README.md` says which).
