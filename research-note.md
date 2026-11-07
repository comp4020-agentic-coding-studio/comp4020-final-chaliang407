# Beyond Autonomy: The Verification Gap in Agentic Software Development

The dominant framing of agentic software development treats autonomy as the
metric that matters: how much of the engineering loop an agent can own
before a human steps in. This framing is too coarse. The central challenge
is not increasing autonomy, but ensuring that **verification capacity keeps
pace with delegated capability**. Autonomy, execution capability,
verification capacity, and accountability are distinct properties, and
conflating them is where agentic practice goes wrong: an agent can gain
execution capability — completing longer, more complex tasks unsupervised —
without any gain in the capacity to check the work was right, or in who is
accountable if it was not.

Practitioner literature already treats this as settled. Anthropic's own
guidance for building agents (Anthropic, 2024) recommends the least
autonomous architecture that solves the problem, guardrails such as a
second model instance screening outputs, and checkpoints where an agent
pauses for human feedback — noting "human review remains crucial" even once
automated tests pass. Coming from a company with every incentive to
champion autonomy instead, this treats verification as a first-class
constraint, not an afterthought. Older work on single-turn coding
assistants points the same way, though it predates today's autonomous
agents: Perry et al. (2023) found developers using such an assistant wrote
less secure code than a control group while believing more strongly it was
secure. The danger was not that the model failed; it was that humans
stopped checking — plausibly worse once an assistant acts with less
turn-by-turn supervision.

A serious counterargument deserves more than a token mention. Kwa et al.
(2025), in work accepted at NeurIPS, show the length of task an AI system
can complete autonomously with 50% reliability has roughly doubled every
seven months since 2019. If execution capability keeps compounding, today's
verification bottleneck may be a symptom of immature models, not a
permanent feature of agentic work. Ho and Yeung (2026), in California
Management Review, offer a complementary argument: in the "principal
worker" model their abstract describes, a human delegates subtasks to AI
agents and orchestrates results, and such workers "produce more and earn
more" (only this abstract-level claim is used). Together, these suggest
chasing ever-tighter oversight could be fighting the wrong trend —
optimizing for a constraint the technology is dissolving.

This counterargument does not survive close reading of its own best
evidence: it quietly keeps verification rather than eliminating it. Ho and
Yeung's abstract warns automation bias must be guarded against and that the
principal worker remains "ultimately responsible" for the output: autonomy
is delegated at execution, while verification and accountability stay with
the human. Their strongest source confirms the thesis rather than refuting
it — execution capability moved, verification and accountability did not.
Becker et al. (2025) supply a sharper warning about what happens when that
distinction is lost. In a randomized trial, 16 experienced open-source
developers using contemporary AI tools took 19% *longer* to complete real
tasks, yet afterward believed the tools had made them roughly 20% faster.
The authors warn against generalizing from their small, possibly biased
sample, and METR has since said the result may be outdated against newer
tooling. What it still illustrates is that self-reported confidence and
measured outcome can diverge sharply — the failure mode letting delegated
capability outrun verification capacity unnoticed. Mitchell et al.
(2026) — a position paper, not an empirical study — sharpen this further:
current agent designs may erode the oversight skills needed to catch
failures, so "human in the loop" is not a stable safeguard unless oversight
is deliberately maintained.

A small instance of this pattern surfaced in this project's own history: a
review found a defect — an error path carrying an identifier never meant to
be exposed — that passing tests had not caught and developer confidence
alone would not have surfaced. That single data point proves nothing in
general, but it illustrates the same mechanism at smaller scale: behaving
correctly by one's own tests is not the same claim as behaving correctly,
and closing that gap takes deliberate, separate verification, not more
trust in the delegate.

Good agentic practice is not a fixed human-to-machine ratio, nor is all
agent autonomy suspect. It requires an explicit, revisited answer to four
questions: how much execution is delegated, how far the delegate can act
unchecked, who verifies output independently of the agent that produced it,
and who is accountable if verification fails. As execution capability
compounds, what distinguishes good agentic development from reckless
automation is not slower delegation but verification and accountability
built to scale at the same rate.

## References

Anthropic. (2024). *Building effective agents*. Anthropic Engineering.
https://www.anthropic.com/research/building-effective-agents

Becker, J., Rush, N., Barnes, E., & Rein, D. (2025). *Measuring the impact of
early-2025 AI on experienced open-source developer productivity* (arXiv
preprint No. 2507.09089). METR. https://arxiv.org/abs/2507.09089

Ho, T.-H., & Yeung, C. (2026). Principal workers: Orchestrating AI agents
improves productivity. *California Management Review* (OnlineFirst).
https://doi.org/10.1177/00081256261470827

Kwa, T., West, B., Becker, J., Deng, A., Garcia, K., Hasin, M., Jawhar, S.,
Kinniment, M., Rush, N., Von Arx, S., Bloom, R., Broadley, T., Du, H.,
Goodrich, B., Jurkovic, N., Miles, L. H., Nix, S., Lin, T., Painter, C.,
Parikh, N., Rein, D., Sato, L. J. K., Wijk, H., Ziegler, D. M., Barnes, E., &
Chan, L. (2025). *Measuring AI ability to complete long tasks* (arXiv
preprint No. 2503.14499). Accepted at NeurIPS 2025.
https://arxiv.org/abs/2503.14499

Mitchell, M., Ghosh, A., & Passi, S. (2026). *AI agents push humans out of
the loop* (arXiv preprint No. 2608.23642). https://arxiv.org/abs/2608.23642

Perry, N., Srivastava, M., Kumar, D., & Boneh, D. (2023). Do users write
more insecure code with AI assistants? In *Proceedings of the 2023 ACM
SIGSAC Conference on Computer and Communications Security (CCS '23)*
(pp. 2785–2799). ACM. https://arxiv.org/abs/2211.03622
