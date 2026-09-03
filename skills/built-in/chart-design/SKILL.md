---
name: Chart Design
description: Turn quantitative comparisons, trends, compositions, and correlations into live Cognia chart artifacts.
category: data-analysis
tags:
  - chart
  - data-visualization
  - analytics
  - artifact
license: MIT
metadata:
  version: "1.0"
  default-enabled: true
  delivery: catalog
  triggers:
    surfaces: []
    intents: [chart, plot, graph-quantitative-data, compare-quantities, show-trend]
  capability-requirements:
    - capability: artifact-authoring
      reason: chart output requires a host artifact route, either the artifact_create tool or the fenced-payload detector
  host-policies: [artifact-channel, permission-ceiling, user-language]
---

# Chart Design for Cognia

Cognia renders charts natively. You do not draw them — you emit the **data**, and
the app's chart renderer (Recharts, in the artifact dock) draws it, themes it,
and makes it hoverable. That is the whole point: a chart artifact stays live and
re-themeable, keeps its own version history, and can be exported. An SVG you drew
by hand is a picture of a chart.

## How to emit one

**Call `artifact_create`.** It is the direct route: you name the chart, you pick
its shape, and the tool returns the id you can pass to `artifact_update` later.

```
artifact_create({
  type: "chart",
  title: "Revenue vs cost by quarter",
  chartType: "bar",
  content: "{\n  \"type\": \"bar\",\n  \"data\": [ … ]\n}"
})
```

`content` is the chart JSON described below. To revise a chart you already made,
call `artifact_update` with its `artifactId` — the reader keeps the version
history and reviews your change as a diff, instead of getting a second chart.

### When `artifact_create` is absent

This skill is offered whenever the host has *some* route to the dock, and that
route is not always the tool. The routing section of your system prompt names
the one this channel actually has, so follow it.

- **It asks for a fenced chart payload.** The dock and its detector are live and
  only the tool was withheld. This is a desktop session, not an IM thread. Emit
  exactly one fenced block tagged `json` whose entire body is the chart object,
  and nothing else inside that fence. Always name the `type`: without it the
  dock draws a line chart whatever the rows contain, and on `pie`, `doughnut`
  and `scatter` that is the difference between the chart you meant and a wrong
  one. The `at least three lines` rule below is the detector's own floor, so a
  single-line blob is left in the transcript as raw JSON.
- **It offers no artifact route at all** — an IM thread, or the user turned
  artifact authoring off. Then do not try to bypass that decision with a fenced
  JSON block: use a compact markdown table or prose instead.

## The data contract

Hard requirements, each of which the renderer or the detector actually enforces:

- **`type`** is one of `line` · `bar` · `area` · `pie` · `doughnut` · `scatter` ·
  `radar`. Anything else silently falls back to `line`.
- **`data`** is a non-empty array of objects.
- **Every row carries `name`**, a string: the category, the bucket, or the point
  in time. It is the x axis on cartesian charts, the slice label on pie/doughnut,
  and the spoke label on radar.
- **Every other key is a number and is one series.** The series list is read
  from the **first row only**, so every series must appear in `data[0]`. A series
  that starts at row two will not be drawn at all. Use `0` rather than omitting a
  key, and never `null`.
- **Pretty-print `content` across at least three lines.** This keeps stored
  chart data reviewable, and on the fenced route it is a hard requirement rather
  than a courtesy: the detector ignores a block of fewer than three lines.
- **Do not specify colours, axis titles, widths or margins.** The renderer owns
  the palette so every chart in the app matches the user's theme in both light
  and dark. A `colors` or `options` key is ignored; hand-picked hex is how a
  chart ends up unreadable in the other theme.

`scatter` is the one shape with a different row contract: it reads **`x` and
`y`** as numbers, not `name` plus series.

```json
{
  "type": "scatter",
  "data": [
    { "x": 12, "y": 4.2 },
    { "x": 19, "y": 5.1 },
    { "x": 27, "y": 5.0 }
  ]
}
```

## Choosing the shape

Pick from the question being asked, not from what looks impressive.

| The question | Shape |
| --- | --- |
| How did this move over time? | `line` (or `area` when the magnitude, not just the direction, is the point) |
| How do these categories compare? | `bar` |
| How does the total split up? | `pie`, or `doughnut` when a total belongs in the middle |
| Do these two measures move together? | `scatter` |
| How does one subject score across several axes? | `radar` |

Guardrails worth honouring:

- **Pie above ~6 slices is unreadable.** Sort descending, keep the top five, and
  fold the rest into one "Other" row. Pie also demands that the parts really are
  parts of one whole — if they are not, it is a bar chart.
- **Multi-series pie does not exist.** `pie` and `doughnut` draw the first
  numeric series only. Two series means bar or line.
- **More than about four series on one cartesian chart** stops being readable.
  Drop to the ones that carry the answer, or emit two charts.
- **Radar needs at least three spokes** and comparable scales across them; a
  radar over mixed units (dollars, percentages, counts) is a shape, not a
  measurement.
- **Time on the x axis must be sorted and evenly spaced.** Fill gaps explicitly
  rather than letting the series skip a month.

## When *not* to reach for a chart

- **Three numbers.** Say them in a sentence. A chart of three numbers takes
  longer to read than the numbers.
- **Precise values matter more than shape** (a price list, a set of IDs, a table
  the user will copy from). Use a markdown table.
- **The relationship is qualitative** — architecture, a flow, a sequence, a state
  machine, an org chart, a timeline of events. That is `diagram-design`, or an
  inline Mermaid diagram when the channel supports it.
- **You are guessing at the data.** Never invent plausible-looking numbers to
  fill a chart. Ask, or chart only what you actually have and say which part is
  missing.
- **This channel has no artifact dock** (an IM connector thread, for instance).
  Chart artifacts live in the dock; where there is no dock, use the channel's own
  rich content or a compact markdown table. No dock is not the same as no tool,
  so check **When `artifact_create` is absent** before falling back.

## Labelling

- Write `name` and every series key in the **user's current language**, and make
  them read as labels: `"Active users"`, not `"active_users_count"`. Series keys
  become the legend text verbatim.
- Keep units consistent within a series and say the unit in the key when it is
  not obvious: `"Revenue (USD)"`, `"Latency (ms)"`.
- Round to the precision the answer needs. Six decimal places in a bar chart is
  noise the renderer will faithfully reproduce.

## Around the chart

Put one or two sentences of prose **before** creating the artifact saying what
the chart shows and what the reader should notice — the finding, not a
description of the axes. A chart with no reading is a shrug.

If the user asked for the underlying numbers as well, give the table *and* the
chart; they are cheap together and answer different questions.
