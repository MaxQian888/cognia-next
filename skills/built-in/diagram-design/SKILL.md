---
name: Diagram Design
description: Create polished technical and product diagrams as responsive HTML with inline SVG. Use when the user asks to draw, visualize, map, chart, or diagram architecture, flows, sequences, data models, timelines, organizations, processes, comparisons, or quantitative relationships.
category: creative-design
tags:
  - diagram
  - svg
  - architecture
  - visualization
license: MIT
metadata:
  version: "2.0-cognia.1"
  default-enabled: true
  upstream-repository: cathrynlavery/diagram-design
  upstream-commit: 8827b277395988877ba997b714b43513f764b569
---

# Diagram Design for Cognia

Create a single self-contained HTML Artifact with inline SVG. The result should feel editorial and deliberately composed: clear hierarchy, restrained color, orthogonal routing, and no decoration that does not carry information.

This Cognia adaptation is based on `cathrynlavery/diagram-design` at commit `8827b277395988877ba997b714b43513f764b569`. See `references/UPSTREAM_LICENSE.txt` and `references/THIRD_PARTY_LICENSES.md`.

## Required output contract

Return exactly one fenced `html` block containing a complete HTML document. Do not write a file and do not emit a second code block.

The document must:

- include `<meta name="cognia-renderer" content="diagram-design-v1">` in `<head>`;
- contain all artwork as inline SVG with a responsive `viewBox`;
- use `svg { display: block; width: 100%; max-width: 100%; height: auto; }` and never use a fixed pixel `min-width`;
- contain no JavaScript, event handlers, forms, remote fonts, external stylesheets, external images, CSS `@import`, or network `url()` values;
- use system font stacks only;
- write every visible label in the user's current language unless the user explicitly requests another language;
- remain readable on narrow screens and with long Chinese labels by allocating sufficient node width and allowing intentional line wrapping;
- include accessible `<title>` and `<desc>` elements in the SVG;
- preserve a useful standalone fallback palette when downloaded.

Use this theme bridge after the diagram's base token declarations so Cognia's active light, dark, or custom theme wins in preview:

```css
:root {
  --paper: var(--background, #f5f5f5);
  --paper-2: var(--card, #ececec);
  --ink: var(--foreground, #2d3142);
  --muted: var(--muted-foreground, #4f5d75);
  --soft: var(--muted-foreground, #7a8399);
  --rule: var(--border, rgba(45, 49, 66, 0.14));
  --rule-solid: var(--border, #bfc0c0);
  --accent: var(--primary, #eb6c36);
  --accent-ink: var(--primary-foreground, #ffffff);
  --accent-tint: color-mix(in srgb, var(--primary, #eb6c36) 10%, transparent);
  --link: var(--info, #2e5aa8);
  --series-1: var(--chart-1, #7c8f6f);
  --series-2: var(--chart-2, #5e7a9b);
  --series-3: var(--chart-3, #b8915a);
  --series-4: var(--chart-4, #9c6b50);
  --series-5: var(--chart-5, #6e6479);
}
```

Start from `assets/template.html` when useful. Load the selected type reference and its matching `assets/example-*.html` before drawing. Load only the resources required for the selected type.

## Choose one diagram grammar

| Showing | Type reference | Standard example |
|---|---|---|
| System components and connections | `references/type-architecture.md` | `assets/example-architecture.html` |
| Legacy IT landscape / current state | `references/type-it-state.md` | `assets/example-it-state.html` |
| Decisions and branches | `references/type-flowchart.md` | `assets/example-flowchart.html` |
| Time-ordered messages between actors | `references/type-sequence.md` | `assets/example-sequence.html` |
| States, transitions, and guards | `references/type-state.md` | `assets/example-state.html` |
| Entities, fields, and relationships | `references/type-er.md` | `assets/example-er.html` |
| Events positioned in time | `references/type-timeline.md` | `assets/example-timeline.html` |
| Cross-functional handoffs | `references/type-swimlane.md` | `assets/example-swimlane.html` |
| Two-axis positioning or prioritization | `references/type-quadrant.md` | `assets/example-quadrant.html` |
| Entities scored across criteria | `references/type-radar.md` | `assets/example-radar.html` |
| Reinforcing cycle or flywheel | `references/type-loop.md` | `assets/example-loop.html` |
| Hierarchy through containment | `references/type-nested.md` | `assets/example-nested.html` |
| Parent-child hierarchy | `references/type-tree.md` | `assets/example-tree.html` |
| Ownership, reporting, or escalation | `references/type-org-chart.md` | `assets/example-org-chart.html` |
| Stacked abstraction levels | `references/type-layers.md` | `assets/example-layers.html` |
| Overlapping sets | `references/type-venn.md` | `assets/example-venn.html` |
| Ranked hierarchy or conversion drop-off | `references/type-pyramid.md` | `assets/example-pyramid.html` |
| Quantitative category comparison | `references/type-bar.md` | `assets/example-bar.html` |
| Continuous trends over time | `references/type-line.md` | `assets/example-line.html` |
| Tasks and phases over time | `references/type-gantt.md` | `assets/example-gantt.html` |
| Distribution and correlation | `references/type-scatter.md` | `assets/example-scatter.html` |
| End-to-end containerized data stack | `references/type-high-level.md` | `assets/example-high-level.html` |
| Multi-actor sequential process | `references/type-process.md` | `assets/example-process.html` |
| Tiered data storage and quality | `references/type-medallion.md` | `assets/example-medallion.html` |
| Role-scoped pipeline responsibilities | `references/type-data-flow.md` | `assets/example-data-flow.html` |
| Data-platform integration topology | `references/type-dp-integration.md` | `assets/example-dp-integration.html` |
| Role/component permission matrix | `references/type-dp-security-matrix.md` | `assets/example-dp-security-matrix.html` |

Do not combine grammars unless the user explicitly asks for a hybrid. If a table or short paragraph communicates the information more clearly, say so instead of forcing a diagram.

## Composition rules

Read `references/style-guide.md` for the complete system. The load-bearing rules are:

- target visual density is about 4/10; split diagrams that exceed the selected type's complexity budget;
- reserve `accent` for one or two focal elements;
- use sans text for names, mono only for technical values, and serif only for a title or editorial callout;
- use orthogonal connectors with rounded corners for off-axis routes; diagonal connectors are a hard failure;
- route connections before boxes, keep labels clear of lines, fan shared ports, and bridge unavoidable crossings on the less important path;
- use borders and whitespace for hierarchy, not shadows, gradients, glow, or excessive rounding;
- keep legends outside the drawing area and remove any element whose meaning is already obvious from layout.

Optional primitives are available in `references/primitive-annotation.md`, `references/primitive-icons.md`, `references/primitive-sketchy.md`, and `references/primitive-terminal.md`. Use them only when they clarify the user's content.

## Pre-output checks

Before returning the Artifact, verify:

1. Exactly one fenced `html` block is present and the renderer marker is exact.
2. The chosen type's reference and standard example were consulted.
3. No `<script>`, `<link>`, `@import`, remote `src`/`href`, or external CSS/image URL remains.
4. The SVG has a `viewBox`, width is responsive, and there is no fixed pixel `min-width`.
5. Text is in the requested language and long labels do not collide or clip.
6. Every connector terminates at a node edge, avoids unrelated nodes, and remains independently traceable.
7. Paper, ink, muted, accent, link, rule, and chart roles map through Cognia variables with static fallbacks.
8. The result remains understandable without color alone and has accessible SVG title/description text.
