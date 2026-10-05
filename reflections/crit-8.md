# Crit 8 reflection

**What was the breakthrough that moved the work forward?**

While manually clicking through the playable interface, I noticed a round
with zero votes — LEFT 0 / JUMP 0 / RIGHT 0 — showing up on screen as "No
majority — TIE." The resolution logic wasn't wrong, exactly: with no unique
winner, calling it a tie is a defensible reading of the numbers. But it was
communicating the wrong thing. A tie like LEFT 1 / JUMP 0 / RIGHT 1 means
people showed up and couldn't agree. Zero votes means nobody showed up at
all. Presenting both the same way made silence look like conflict, which is
the opposite of what I wanted the project to do. The fix itself was small —
let empty rounds keep resolving so the lifecycle stays simple, but suppress
the reveal and hide them from the visible history, while leaving genuine
participated ties alone. What mattered more was that the bug forced me to
actually state what I was building toward: good means making coordination
visible, including failure to coordinate. I didn't have that sentence before
I saw the bug; the bug is where it came from.

**What did this work change about who I want to be as a software developer?**

It reminded me that a state being technically correct isn't the same as it
meaning the right thing to the person looking at it. My tests and resolution
logic were fine; the interface was lying anyway. I want to keep clicking
through my own work like a stranger would, after the logic already passes,
instead of treating a green check as the end of the task.
