# Spec schema — `svggen.cjs`

The generator reads a spec JSON and writes a self-contained SVG:
`node svggen.cjs spec.json out.svg`. All coordinates are **absolute pixels** on a
`w × h` canvas. Draw order (back → front): background → groups → cards → edges →
nodes → header → legend. So put nodes on top of their group container, and edges
render behind nodes (endpoints tuck under the box — intended).

## Top-level fields

| field | type | notes |
|-|-|-|
| `w`, `h` | number | canvas size (px). Size to content + margins. |
| `bg` | string | background fill, default `#ffffff`. |
| `accent` | palette key | header accent-bar color (default teal). |
| `title` | string | header title (bold ~25px). |
| `subtitle` | string | header subtitle (gray). |
| `headerX`, `headerY` | number | header origin, default 40 / 34. |
| `legend` | object | top-right key box (optional). |
| `groups` | array | tinted containers (optional). |
| `cards` | array | titled pill-list panels (optional). |
| `nodes` | array | boxes. |
| `edges` | array | connectors. |

## `nodes[]`

| field | type | notes |
|-|-|-|
| `id` | string | **unique**; referenced by edges. |
| `x`,`y`,`w`,`h` | number | absolute box rect. |
| `title` | string | bold dark text; `\n` splits lines. |
| `sub` | string | gray subtitle under the title; `\n` splits lines. |
| `color` | palette key | border + light fill (see palette). |
| `shape` | `"rect"`(default) `"cyl"` | `cyl` = database cylinder. |
| `tsize`,`ssize` | number | title / subtitle font px (defaults 15.5 / 12.5). |
| `tcolor`,`scolor` | string | override title / subtitle text color. |
| `fill` | string | override the box fill. |
| `rx` | number | corner radius (default 12). |

Text is centered and auto-vertically-centered from the line counts, so you only set
the box rect — no manual text positioning.

## `groups[]`

Tinted rounded container drawn **behind** nodes, with a bold colored title at
top-left. Lay member nodes inside `x/y/w/h`.

| field | type | notes |
|-|-|-|
| `x`,`y`,`w`,`h` | number | container rect. |
| `title` | string | bold colored section label (top-left, inset). |
| `color` | palette key | tint fill + faint border + title color. |
| `fill` | string | override tint fill. |
| `rx` | number | corner radius (default 16). |

## `cards[]`

A titled container with a vertical list of white pill items — auto-height from item
count. The fastest way to build a **system-overview panorama**: one card per layer,
`items` = key modules. Lay cards in a grid (compute each card height =
`40 + n*32 + (n-1)*8 + 16`, add ~38 row gap).

| field | type | notes |
|-|-|-|
| `x`,`y`,`w` | number | top-left + width (height auto). |
| `title` | string | bold colored header with a small accent bar. |
| `items` | string[] | one pill each, centered text. |
| `color` | palette key | tint fill + border + title/bar color. |
| `h` | number | optional fixed height override. |

## `edges[]`

Orthogonal connector, auto-routed (S-shape via the midpoint of the dominant axis),
with a polygon arrowhead. Endpoints attach to node border sides.

| field | type | notes |
|-|-|-|
| `from`,`to` | node id | required. |
| `color` | palette key | line + arrow color (default gray `#94a3b8`). |
| `label` | string | small text; `\n` splits; drawn on a white chip. |
| `fromSide`,`toSide` | `left\|right\|top\|bottom` | force the exit/entry side (else auto by geometry). |
| `fromT`,`toT` | 0..1 | position along that side — **fan out multiple edges** from the same node by giving each a different `fromT`. |
| `waypoints` | `[[x,y],…]` | explicit route; overrides auto-routing for tricky paths (routing around a box, a return loop). |
| `dash` | true or `"5 5"` | dashed line (secondary / async flow). |
| `width` | number | stroke width (default 2). |
| `lx`,`ly` | number | override label position. |
| `lcolor` | palette key | label text color. |

## Palette keys

`blue green orange purple cyan slate red amber teal indigo rose` — each a matched
`(stroke, light-fill)` pair. Node/group/card `color` and edge `color` all take these.
Assign **one hue per layer / process / owner** and reuse it for that group's nodes,
its container, and its outgoing edges — the color coding is what makes a dense
diagram readable. Put the mapping in the `legend`.

## `legend`

```json
"legend": { "title": "进程 / 存储", "x": 1378, "y": 92, "w": 208,
  "items": [ { "color": "blue", "label": "渲染进程" }, { "color": "orange", "label": "Rust 后端" } ] }
```
`x`/`y` default to top-right; set them explicitly to avoid colliding with a group.

## Layout tips (learned the hard way)

- **Manual grid.** Sketch columns/rows, assign coordinates. Keep a node inside its
  group's rect with ~30px inset.
- **Gaps ≥ ~70px** between chained boxes, or the edge-label chip overlaps the boxes.
  For a tight 5–6 box pipeline, use **circled-number labels** (`①②③④⑤`) — a single
  glyph fits any gap — and carry the real description in each node's `sub`.
- **Fan out** several edges from one node with distinct `fromT` values (e.g. a
  `cognia-core` node feeding 5 crates: `fromT` 0.2 / 0.4 / 0.55 / 0.72 / 0.88).
- **Return loops / go-arounds** (a reply path, an edge that must skip over a box):
  give explicit `waypoints`. Route just outside the group border, then in.
- **Cylinders** (`shape:"cyl"`) for any datastore (Dexie, sqlite-vec, keyring).
- **Verify geometry** before Feishu: `whiteboard-cli -i x.svg --check` reports text
  overflow and node overlap without rendering.
