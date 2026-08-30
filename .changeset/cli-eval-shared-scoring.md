---
"cognia-next": patch
---

Fix `cognia eval run` reporting recommendations it had no evidence for. The CLI carried its own quality heuristic whose last branch scored any non-empty answer as a perfect 1.0, so a dataset with no reference answers — or one whose references never stated how they should be compared — produced a flawless score on every case and a confidently recommended variant. The CLI now grades with the same deterministic scorers the in-app engine uses, so a case no scorer can grade is reported as ungraded instead of passing, and the decision only counts cases that were actually judged: a run without gradable evidence now exits with "no conclusion" rather than naming a winner. Confidence intervals are also computed as the single-sample mean interval they always were, instead of a paired comparison against a baseline that never ran. Provider failures still count as real failures, so a variant that crashes loses the comparison rather than dropping out of it.
