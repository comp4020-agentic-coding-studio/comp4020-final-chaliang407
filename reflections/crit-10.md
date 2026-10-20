# Crit 10 reflection

**What was the breakthrough that moved the work forward?**

The read-only audit surfaced something I hadn't expected: C10's brief sounds
like it's asking for new authorization logic, but the app already had
everything that mattered — an anonymous cookie that two Chrome profiles get
distinct copies of automatically, and no endpoint that accepts a
client-supplied identity to spoof. The actual gap was that none of it was
*visible*: six `console.*` calls, none saying who voted or what a round
resolved to. The breakthrough was realizing identifying a *browser* and
identifying a *person* are different claims, and the brief only needed the
first — logging had to make that existing, narrower boundary legible, not
invent a stronger one. Writing `docs/adr/0003` is where I had to say plainly
that cookie possession, not personhood, is the whole credential, and that a
label derived from it by HMAC is honest about what it can and can't prove.

**What did this work change about who I want to be as a software developer?**

A privacy review after the logging "worked" caught a latent leak — an error
message that interpolated a raw voter id, sitting one careless
`console.error(err)` away from exposure — that the passing tests never would
have caught, because nothing exercised that specific catch-all with that
specific error. I want to keep treating "does it log the happy path
correctly" and "could any path leak the thing I promised to protect" as
separate questions. Live two-Chrome-profile verification against the deployed
app is still pending — not claimed as done, because it genuinely isn't yet.
