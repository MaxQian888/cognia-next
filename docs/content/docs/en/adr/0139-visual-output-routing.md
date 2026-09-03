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

## Amendment (2026-09-03) — Contracts for the other four surfaces

The decision above is unchanged: routing resident, contracts in skills. It was
half-implemented. Four of the five surfaces had a route named for them and no
contract behind it, and the renderer never became honest about the failures
this ADR's own Context section enumerated.

**The renderer now says what it could not draw.** `chart-renderer.tsx` had no
validation at all, so every rule listed above failed in silence. The worst was
not listed: pie and doughnut hardcoded `dataKey="value"`, so a chart whose
series was called anything else rendered completely blank, and every fixture in
the suite used `value`. `lib/artifacts/chart-contract.ts` is now the single
answer to what a payload means, and a non-blocking notice above the chart lists
what was dropped and why. The chart still draws whatever it can.

**The chart contract forbade the route the host asks for.** In `fenced` mode the
routing prompt requests a fenced payload and the same turn delivered a skill
saying not to emit one. The prohibition assumed a missing `artifact_create`
meant a missing dock. It does not: `fenced` is a desktop session with a live
dock and the tool withheld, while the IM case resolves to `disabled`. Scoped,
not deleted.

**The envelope.** Detection never set `chartType`, so a fenced payload could
only express its shape through an in-content `{"type": ...}` wrapper that no
prompt documented, and everything else fell back to a line chart. This belongs
in the ADR because the Context section above lists the detector's silent
failures and missed this one. Detection now stamps a shape it can resolve and
leaves an ambiguous payload unpinned.

**Mermaid had no contract anywhere**, despite being the default for structural
content and the only surface that works on `disabled`. `diagram-design` now
owns it, with the grammar list verified against the installed renderer rather
than transcribed from docs.

**The rule for what goes resident.** A fact belongs in the prompt rather than a
skill when either it applies on a channel that gets no skill at all, or
breaking it fails silently and the model could not have recovered the rule from
a tool's JSON schema. This is why two Mermaid rules are resident (an IM thread
gets no `diagram-design`), and why the canvas `language` and `type` enums are
not (the tool schema carries them). What no schema says is that `canvas_update`
rewrites the whole buffer, so that one sentence is resident.

**Budget.** The ceiling moves from 1,400 to 1,700 characters. This is not a red
test turned green: 1,400 was infeasible, since the leanest `tools` variant
lands at 1,420 with these contracts, and fitting under the old number meant
deleting the only memorable line in the section to buy fifteen characters of
permanent headroom. A second guard pins the `disabled` variant under 1,100,
which encodes this ADR's actual principle better than one global number does:
the channel that can use the least routing pays the least for it. The
Consequences note above saying "roughly 150 tokens" was already wrong before
this change; it is closer to 380 now.

**Deliberately not done.** Dropping `diagram-design`'s `artifact-authoring`
requirement so the full Mermaid contract reaches an IM thread. It is tempting
and it is the mechanism, but the skill's bulk and its `assets/*.html` resources
are dead weight where only one of its two routes exists. Named here so the next
person does not have to re-derive it.

## References

- ADR-0026 — marketplace integrations, built-in skill manifest, connector
  capability prompt
- ADR-0138 — reading-area layout stability (the other half of the render work)
- `skills/built-in/chart-design/SKILL.md`,
  `lib/ai/prompts/visual-output-prompts.ts`,
  `components/artifacts/chart-renderer.tsx`,
  `lib/ai/generation/artifact-detector.ts`
