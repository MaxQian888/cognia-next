---
"cognia-next": minor
---

Evaluation can now score real conversations as they happen, not just datasets you assembled by hand. Define a policy — which surfaces, models, or projects to watch, and which checks to run — and finished agent turns are picked up in the background, scored, and recorded alongside your offline runs under one definition of what a verdict means. Free deterministic checks run on everything matched; LLM judges are sampled and cannot be enabled at all without a daily spending cap, with errored turns getting first claim on that sample. Nothing is scored twice, a turn refused by the budget is recorded with the reason rather than quietly dropped, and results are pruned on a schedule instead of accumulating. Online evaluation is off until you create a policy, and it follows the agent-tracing setting: with tracing off there are no turns to score.
