---
name: lark-arch-diagram
description: >-
  Draw polished, hand-styled SVG architecture / flow / topology / data-flow /
  system-panorama diagrams and put them on a Lark (Feishu) whiteboard or into a
  Feishu doc. Use this whenever the user wants 美观的架构图 / 系统图 / 流程图 / 拓扑图 /
  数据流图 / 时序流程 / 产品全景 rendered as a Feishu 画板, wants to 把架构图放进飞书文档,
  or says the mermaid version looks too plain and wants design-quality diagrams
  (titled header + legend + tinted group containers + boxed nodes + orthogonal
  connectors). Triggers: 「给项目画架构图」「飞书画板架构图」「架构图放到飞书文档」
  「画一张系统/流程/拓扑/数据流图」「美观一点的图」「自绘 SVG 图」「像这样的图(贴参考图)」.
  English: "draw an architecture / flow / topology diagram on a Feishu whiteboard",
  "put architecture diagrams in a Lark doc", "make a nicer styled diagram than mermaid".
  Prefer this over raw mermaid when design quality matters, and over
  lark-whiteboard-mindmap when the diagram is a code/system architecture (boxes +
  connectors) rather than a page map with real screenshots.
---

# Lark Architecture Diagram (styled SVG → Feishu whiteboard / doc)

Produce **design-quality** architecture diagrams — the "titled header + legend +
tinted group containers + boxed nodes (bold title + gray subtitle) + orthogonal
connectors with arrowheads" look — and land them as **editable Feishu 画板**, either
standalone or embedded in a Feishu doc.

The engine is a small data-driven generator (`scripts/svggen.cjs`): you write a
declarative JSON **spec** (nodes with absolute coordinates, groups, cards, edges,
legend), it emits a self-contained SVG. Feishu re-parses that SVG into an editable
whiteboard. Mermaid auto-layout is the quick-but-plain alternative; this skill is
for when the result should look hand-crafted.

## Why SVG and not mermaid

Mermaid on Feishu is fast (`<whiteboard type="mermaid">`) but you don't control
layout, spacing, color, or grouping — it always looks generic. Hand-authored SVG
gives full control over the aesthetic, and Feishu's SVG parser faithfully turns it
into native nodes/connectors. The cost is you place coordinates yourself; the
generator absorbs all the styling and routing so the spec stays small.

## The pipeline

```
① write spec.json (nodes/groups/cards/edges/legend, absolute coords)
② node svggen.cjs spec.json out.svg           # spec → styled SVG
③ whiteboard-cli -i out.svg -o out.png -s 2   # local PNG preview — iterate here
④ docs +create … <whiteboard type="svg" path="@out.svg">   # land in Feishu
⑤ whiteboard +query --output_as image         # export thumbnail, verify Feishu render
```

**Always preview locally (③) and iterate before writing to Feishu.** Rendering is
cheap; writing to a user's Feishu is outward-facing. Only after the PNG looks right
do you create the doc. After creating, always export thumbnails (⑤) to confirm
Feishu's parser rendered it — its SVG/mermaid support is stricter than the local CLI.

## Setup

Copy the generator and a sample spec into a work dir (use the scratchpad, not the
repo), keep SVGs and specs together:

```bash
cp <skill>/scripts/svggen.cjs <work>/
cp <skill>/scripts/spec.sample.json <work>/spec-1.json   # rect/group/cylinder/legend example
cp <skill>/scripts/spec.cards-sample.json <work>/         # card-panorama example (system overview)
```

Dependencies: `node`, `npx` (pulls `@larksuite/whiteboard-cli@^0.2.11`), and
`lark-cli` logged in as user (see the `lark-shared` skill for auth). All `lark-cli`
calls use `--as user`.

## Step ① — write the spec

The spec is declarative JSON. Full field reference and the color palette are in
[`references/spec-schema.md`](references/spec-schema.md) — read it before authoring.
The short version:

- **`nodes`** — boxes with **absolute** `x/y/w/h`, `title` (`\n` for multi-line),
  optional `sub` (gray subtitle), `color` (palette key), `shape:"cyl"` for a
  database cylinder.
- **`groups`** — tinted rounded containers drawn behind nodes, with a bold colored
  section title. Lay your nodes inside a group's rectangle.
- **`cards`** — a titled container with a vertical list of pill items; auto-height.
  This is the fastest way to build a **system-overview panorama** (one card per
  layer, items = modules). See the cards sample.
- **`edges`** — `from`/`to` node ids, optional `label`, `color`, `dash`,
  `fromSide`/`toSide` (`left|right|top|bottom`), `fromT`/`toT` (0..1 position along
  the side to fan out multiple edges), or explicit `waypoints` for tricky routes.
- **`legend`** — top-right key box; **`title`/`subtitle`/`accent`** — the header.

**Layout is manual.** Sketch a grid, give each node/group a coordinate. The
generator auto-routes orthogonal S-shaped connectors and draws arrowheads. Keep
horizontal gaps between chained nodes ≥ ~70px, or the edge label chips overlap the
boxes — where space is tight (a dense 5–6 box pipeline), use **circled-number
labels** (`①②③…`) and carry the description in node subtitles instead.

## Step ② / ③ — generate and preview

```bash
node svggen.cjs spec-1.json 1.svg
npx -y @larksuite/whiteboard-cli@^0.2.11 -i 1.svg -o 1.png -s 2   # or --check for overlap report
```

Read `1.png`, fix coordinates/labels, regenerate. This is the iteration loop —
stay here until it looks right.

## Step ④ — land in Feishu

Reference each SVG by **path**, not inline, to avoid XML-escaping the SVG's `<`/`>`.
Build the doc XML (headings + a short prose paragraph per section + a whiteboard
block), then create it from the directory that holds the `.svg` files so `@name.svg`
resolves. Full recipe, the mermaid alternative, and every trap are in
[`references/lark-pipeline.md`](references/lark-pipeline.md) — read it before writing
to Feishu. The core call:

```bash
cd <work>   # dir containing the .svg files and doc.xml
lark-cli docs +create --content "$(cat doc.xml)" --as user --json
# doc.xml uses: <whiteboard type="svg" path="@1.svg"></whiteboard>
```

The response returns `data.document.url` and `new_blocks[]` with a `block_token`
per whiteboard. **Check `new_blocks` has one entry per diagram** and there is no
`degrade_code=2107` warning — a missing entry means that SVG failed to parse.

## Step ⑤ — verify the Feishu render

```bash
lark-cli whiteboard +query --whiteboard-token <block_token> --output_as image \
  --output fb-1.png --as user
```

Read each `fb-*.png`. Exports use a fixed 2560² canvas so files are small (1–8 KB
of mostly-whitespace) but faithful; a **0 KB** file is a transient fetch failure —
just re-run that one. Confirm every diagram rendered before telling the user it's done.

## Design system (what the aesthetic is)

Held in the generator so every diagram matches:

- **Header** — accent color bar + bold ~25px title + gray subtitle.
- **Legend** — white rounded box, top-right, colored swatch + label rows.
- **Group container** — light-tint rounded rect, faint border, bold colored title top-left.
- **Node** — light-tint fill, 2px colored border, bold dark title, gray subtitle; `cyl` = database.
- **Connector** — 2px orthogonal polyline, polygon arrowhead, optional white-chip label.
- **Palette** — blue / green / orange / purple / cyan / slate / red / amber / teal / indigo / rose,
  each a matched (stroke, light-fill) pair. Assign one hue per layer/owner for legibility.

## References

- [`references/spec-schema.md`](references/spec-schema.md) — every spec field, the palette, layout tips.
- [`references/lark-pipeline.md`](references/lark-pipeline.md) — Feishu doc/whiteboard insertion,
  verification, the mermaid quick-route, and the traps (mermaid `sequenceDiagram` + `<br/>`,
  SVG parser limits, delete scope, etc.).
- `scripts/svggen.cjs` — the generator. `scripts/spec.sample.json` (boxes/groups/cylinder/legend)
  and `scripts/spec.cards-sample.json` (card panorama) — copy and edit; fastest way to start.

## Related skills

- **`lark-whiteboard-mindmap`** — hierarchical mindmaps with **real screenshots** per leaf
  (page maps / product panoramas). Use that when nodes are app screenshots; use **this** for
  code/system architecture (styled boxes + connectors).
- **`lark-whiteboard`** — view/export/update an existing whiteboard (incl. DSL/mermaid updates).
- **`lark-doc`** — create/edit the surrounding Feishu doc; this skill inserts whiteboards into one.
