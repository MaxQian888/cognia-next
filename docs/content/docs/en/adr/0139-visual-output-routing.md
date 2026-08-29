---
title: "0139 — Visual output routing"
description: "Five ways to show a picture, one resident decision table, and the chart contract written down where a model can read it."
---

# ADR 0139 — Visual output routing

**Status:** Accepted
**Date:** 2026-08-21

## Context

Cognia can render a picture five different ways:

| Surface | Where it renders | Live? |
| --- | --- | --- |
| `mermaid` fence | inline in the message | no |
| chart artifact | the artifact dock (Recharts) | **yes** — themed, hoverable, versioned, exportable, re-bindable |
| A2UI surface | inline, and projected into IM | **yes** — with callbacks |
| canvas document | the Canvas guild (store-driven reveal), previewed inline | **yes** — editable |
| `diagram-design` skill | a self-contained HTML + inline SVG artifact | no |

Nothing told a model the difference, and two gaps followed.

**No chart contract exists in writing.** `components/artifacts/chart-renderer.tsx`
has drawn seven shapes for a long time. Its data contract is enforced in three
separate places and each rule fails **silently** when broken:

- the artifact detector keys on a fenced `json` block **and** has a line-count
  floor, so a single-line blob is never lifted into the dock — the reader sees
  raw JSON in the transcript;
- the renderer derives its series list from `data[0]` **alone**, so a series
  first appearing on row two is never drawn;
- `scatter` reads `x`/`y`, not `name` plus series;
- the palette is the renderer's, so hand-picked hex reads fine in one theme and
  is invisible in the other.

None of that is guessable, so in practice the model reached for hand-drawn SVG —
a picture of a chart instead of a chart.

**Nothing routes between the five.** The observed failures are the ones you would
predict: a chart artifact emitted into an IM thread that has no dock to open it
in; a static diagram where the reader actually had to choose something; a
markdown table where a trend was the whole point; a chart of three numbers.

## Decision

### The contract goes in a skill, the routing goes in the prompt

Two different questions, two different homes.

**"How exactly do I emit a chart?"** is long, only matters once you have decided
to emit one, and should cost nothing until then. That is the new `chart-design`
built-in skill (`skills/built-in/chart-design/SKILL.md`): the JSON contract, the
shape-selection table, the readability guardrails (pie above ~6 slices, no
multi-series pie, radar needs comparable scales), and the cases where a chart is
the wrong answer entirely.

**"Which of the five should this be?"** has to be answered *before* the model
knows a skill exists, and a skill is only read once something thinks to load one.
So the routing is resident: `buildVisualOutputSection` in
`lib/ai/prompts/visual-output-prompts.ts`, appended to `appendSystemPrompt` on
every send beside the A2UI prompt and the connector-capability section. It is
deliberately a decision table and nothing else — it is charged to every turn, so
it earns its budget by being short (its own test pins the ceiling).

### The routing is cut to the channel

`artifacts: !session?.platformBinding?.adapterId`. An IM-bound session has no
artifact dock, so that branch withholds the chart and canvas options and says
why, rather than silently omitting them — a model that emits one anyway should
know the reader gets raw JSON. `a2ui` reuses the flag the A2UI prompt block
already resolved.

This mirrors what the connector-capability section (ADR-0026 §G6) already does
for A2UI kinds: tell the model what this channel can actually render, rather than
letting it discover the answer through the reader.

### Seeding needs no version bump

`lib/db/skills.ts` `put`s every catalog entry on boot and preserves user
overrides, so `chart-design` reaches existing installs on the next launch.

## Consequences

- Every turn carries roughly 150 tokens of routing. Accepted: the failure it
  prevents costs a whole reply.
- The chart contract now has one written home. If `chart-renderer.tsx` changes
  its parsing, the skill and its contract test have to change with it — the test
  asserts the specific clauses (`first row only`, `at least three lines`,
  `Do not specify colours`) rather than that the file is non-empty.
- A drawn SVG chart remains possible and is now explicitly discouraged wherever
  the dock is available.
- Long tail: `jupyter` and plugin-registered renderers are not in the routing
  table. They are reached deliberately (a notebook, a plugin's own output), not
  chosen from a menu, so adding them would cost budget for no decision.

## References

- ADR-0026 — marketplace integrations, built-in skill manifest, connector
  capability prompt
- ADR-0138 — reading-area layout stability (the other half of the render work)
- `skills/built-in/chart-design/SKILL.md`,
  `lib/ai/prompts/visual-output-prompts.ts`,
  `components/artifacts/chart-renderer.tsx`,
  `lib/ai/generation/artifact-detector.ts`
