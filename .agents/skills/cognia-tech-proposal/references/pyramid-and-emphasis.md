# Conclusion-first proposal writing

## Four rules

1. **Lead with the answer.** Put the recommendation before supporting detail.
2. **Group mutually exclusive, collectively sufficient arguments.** Avoid overlapping buckets and missing dimensions.
3. **Order by importance or causality.** Review decisions and risks come before implementation trivia.
4. **Support each conclusion with evidence.** Facts, measurements, source paths, and reproducible commands outrank adjectives.

## SCQA context

Use Situation–Complication–Question–Answer:

- **Situation:** stable current facts the audience accepts.
- **Complication:** the failure, constraint, cost, or change that makes the current state insufficient.
- **Question:** the decision the proposal must answer.
- **Answer:** the recommended design and expected result.

Example:

```text
S: The desktop, mobile, and headless surfaces share one command contract.
C: One provider-specific branch bypasses cancellation and emits an incompatible terminal event.
Q: How can all hosts preserve one public lifecycle without duplicating provider logic?
A: Normalize provider events at the adapter boundary and keep one canonical lifecycle reducer.
```

Do not turn SCQA into four headings when one compact paragraph is clearer.

## Executive summary

Write 3–5 lines:

- **Change:** recommendation in one sentence.
- **Reason:** confirmed problem and magnitude.
- **Impact:** layers/contracts/data/security/rollout.
- **Decision:** 1–3 items reviewers must approve.

The summary is not an introduction; it is the proposal's top-level conclusion.

## Section construction

For each section:

1. Write the conclusion as the title or first sentence.
2. Add 2–4 grouped arguments.
3. Attach evidence to each argument.
4. State tradeoff/limit.
5. Link the next dependency or decision.

If the section cannot be summarized in one sentence, it probably mixes concerns.

## Emphasis

Use emphasis sparingly:

- bold the recommendation, invariant, or changed contract;
- use a callout for a decision that invalidates an earlier assumption;
- mark diagram changes explicitly;
- use tables for repeated comparisons;
- use code blocks for exact schemas/contracts only.

Do not bold entire paragraphs or decorate every bullet.

## MECE checks

Common grouping dimensions:

- lifecycle: create → run → interrupt → resume → archive;
- layers: UI → state → host → service → external system;
- quality: correctness → security/privacy → reliability → performance → operability;
- rollout: prepare → dual-read/write → migrate → cut over → remove compatibility;
- risk: product → data → protocol → platform → operational.

Choose one dimension per list. Do not mix “frontend”, “high risk”, and “phase 2” as sibling categories.

## Title-only test

Read only:

1. executive summary;
2. section titles;
3. first sentence of each section;
4. decision list.

They should form a coherent story: problem → recommendation → contracts → safety → proof → decisions. If not, rewrite structure before polishing prose.

## Anti-patterns

- “Background / Design / Other” headings with no conclusion.
- Chronological research diary.
- Options with no recommendation.
- Large evidence dump before explaining why it matters.
- “Improve performance” with no baseline or target.
- Repeating the same argument under architecture, risks, and rollout.
- Hiding the most consequential tradeoff in an appendix.
