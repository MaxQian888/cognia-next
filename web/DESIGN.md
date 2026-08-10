---
version: alpha
name: Cognia Website
description: An editorial, evidence-led instrument for understanding Cognia before installing it.
colors:
  paper: "#F3F1EC"
  surface: "#FAF9F6"
  ink: "#0C1115"
  graphite: "#151B20"
  stage: "#0C1115"
  stone: "#8E959B"
  muted: "#5F666E"
  hairline: "#D7D8D5"
  hairline-strong: "#B9BCB8"
  action: "#35CEDD"
  approval: "#D99A3D"
  success: "#2A6F49"
  destructive: "#B3261E"
  on-stage: "#F3F1EC"
  on-stage-muted: "#8E959B"
  on-stage-hairline: "#2A333A"
typography:
  display:
    fontFamily: Geist Sans
    fontSize: "clamp(2.25rem, 5vw, 4.5rem)"
    fontWeight: 500
    lineHeight: 1.08
    letterSpacing: "-0.025em"
  display-og:
    fontFamily: Geist Sans
    fontSize: 68px
    fontWeight: 500
    lineHeight: 1.08
    letterSpacing: "-0.025em"
  headline:
    fontFamily: Geist Sans
    fontSize: "clamp(1.875rem, 3.5vw, 3rem)"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: Geist Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.1em"
  code:
    fontFamily: Geist Mono
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.5
  micro:
    fontFamily: Geist Mono
    fontSize: 10px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.1em"
rounded:
  control: 8px
  panel: 12px
  stage: 14px
spacing:
  hairline: 1px
  control-gap: 8px
  content-gap: 24px
  section-tight: 80px
  section-normal: 160px
  section-open: 224px
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-stage}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    height: 48px
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    height: 48px
  product-panel:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.on-stage}"
    rounded: "{rounded.panel}"
    padding: 24px
  execution-stage:
    backgroundColor: "{colors.stage}"
    textColor: "{colors.on-stage}"
    rounded: "{rounded.stage}"
    padding: 24px
---

# Cognia Website Design System

## Overview

**Creative North Star: “The Precision Workbench.”**

The website should feel like an instrument for evaluating Cognia, not a generic AI launch page. It pairs an editorial paper layer with a dark execution layer: the former explains, the latter proves. Every major claim should be adjacent to product evidence, a source, or a clear route to verification.

The system is spacious around the argument and dense inside product demonstrations. It uses hairline rules, measured offsets, task receipts, paths, and state marks to communicate structure. Visual drama comes from scale, rhythm, and the contrast between reading and execution surfaces—not gradients, ornamental effects, or invented metrics.

The source of truth is `app/globals.css` plus the components under `components/`. This file is the target-specific contract for Impeccable and other design agents. The detailed rationale remains in `docs/research/cognia-official-website-v2-design-spec-2026-07-26.md` and ADR-0092.

**Key characteristics:**

- Evidence-led and product-specific.
- Editorial outside; operational inside.
- Wide typography and asymmetric composition.
- Hairline structure instead of card stacks and shadows.
- Motion that explains state and always has a reduced-motion alternative.

## Colors

The palette is warm neutral paper, near-black ink, and one scarce cyan signal. Dark execution surfaces remain dark in both themes so product states keep the same meaning.

### Primary

- **Paper** (`#F3F1EC`): the primary reading surface.
- **Ink** (`#0C1115`): primary text and the dark execution substrate.
- **Action cyan** (`#35CEDD`): paths, focus, active state, and connection signals only.

### Secondary

- **Approval amber** (`#D99A3D`): waiting-for-human-confirmation states only.
- **Graphite** (`#151B20`): terminals, diffs, workflow surfaces, and product chrome.

### Neutral

- **Surface** (`#FAF9F6`): adjacent reading regions and inset surfaces.
- **Muted** (`#5F666E`): AA-safe secondary text on paper.
- **Stone** (`#8E959B`): decorative marks, disabled states, and secondary text on dark stages.
- **Hairline** (`#D7D8D5`): structural rules and region boundaries.

### Named rules

**The Five Percent Rule.** Cyan occupies no more than roughly five percent of a viewport. It is a line, dot, focus ring, or state fill—never normal body text.

**The Meaningful Amber Rule.** Amber is not a brand flourish. It appears only when a human approval or waiting state is real.

**The No AI Gradient Rule.** Do not introduce purple-blue gradients, neon glows, or aurora backgrounds as shorthand for intelligence.

## Typography

**Display and body:** Geist Sans.  
**Status, paths, commands, and provenance:** Geist Mono.

The pairing should read as editorial prose supported by precise machine evidence. Mono is an information typeface here, not decoration.

### Hierarchy

- **Display** (500, `clamp(2.25rem, 5vw, 4.5rem)`, 1.08): one homepage H1, held to two lines on desktop and no more than three on narrow screens.
- **Headline** (500, `clamp(1.875rem, 3.5vw, 3rem)`, 1.2): major chapter titles with wide measures.
- **Body** (400, 16–20px, 1.6–1.7): claims and explanations, normally limited to `max-w-2xl`.
- **Label** (400, 10–12px, tracked uppercase): real categories, states, paths, and table headings.
- **Product code** (400, 10–11px, 1.4–1.5): faithful terminal, diff, file-tree, and reconstructed product detail.
- **OpenGraph display** (500, 68px, 1.08): fixed-size social-image rendering only; it is not a page typography step.

### Named rules

**The Two-Line Hero Rule.** A desktop hero heading must use a wide measure and remain within two lines. Reduce type before narrowing the measure.

**The Operational Mono Rule.** Use mono only for content that behaves like an index, state, command, path, measurement, or provenance marker.

## Layout

Use the 1480px shell and its implied twelve-column rhythm. Major sections alternate dense demonstrations with large breathing intervals instead of repeating equal card grids. Off-grid offsets are welcome when they reveal the underlying measure; arbitrary misalignment is not.

The homepage follows an evidence-oriented AIDA sequence:

1. **Attention:** product category, promise, action, and a visible workbench.
2. **Interest:** one task carried end to end and one gapless workbench map.
3. **Desire:** desktop depth, model boundaries, connections, and trust evidence.
4. **Action:** one high-contrast close with download/source routes.

Gapless Bento layouts use `grid-flow-dense` and must close mathematically at every explicit breakpoint. Mobile layouts become one readable primary surface per screen; desktop-only pinning or large visual crops must degrade to ordinary document flow.

## Elevation & Depth

The website is flat by default. Region hierarchy comes from tone, border, crop, overlap, and scale. Do not combine a tone shift, border, and shadow merely to make a box feel important.

Dark execution stages may use restrained inset depth when needed to separate chrome from content. Large ambient shadows, glass blur, and floating card stacks are outside the system.

**The One Separator Rule.** Separate adjacent regions with a tone change or a hairline whenever either is sufficient.

## Shapes

Controls use 8px corners, product panels 12px, and large stages 14px. These are structural radii, not a rounded aesthetic. Avoid oversized pills; reserve full rounding for small dots or status geometry with no text.

The recurring silhouette is a bounded work surface: rectangular, cropped, and divided by rules. Product screenshots and reconstructions may break the reading measure, but never the viewport.

## Components

### Buttons

- **Primary:** ink background, on-stage text, 48px minimum height, 8px radius.
- **Secondary:** paper/surface background, ink text, visible strong hairline.
- **Hover and focus:** state must remain legible without motion; focus uses the action token with a 2px outline.
- **Copy:** use a concrete verb and destination. Avoid vague “Explore” or “Get started” labels when “View source” or “Build from source” is truthful.

### Cards and containers

- Prefer contiguous regions divided by `gap-px` hairlines over collections of floating cards.
- A card needs a real information boundary, not merely a desire to decorate a paragraph.
- Interactive surfaces reveal affordance on hover and `:focus-within`; touch layouts must not rely on hover.

### Product stages

- Prefer a real capture when the complete locale/theme cell exists.
- Otherwise use a DOM reconstruction that is permanently labelled as such.
- Reconstructions expose one accurate alt description, not a tree of fake controls.
- Scale/fade motion may support entry, but the content must remain complete under reduced motion.

### Navigation

- Keep the brand, primary product routes, docs/source access, locale, theme, and current install action visible without building a mega-menu.
- Mobile navigation uses one labelled menu trigger with a 44px minimum target.
- Active and expanded state must be programmatically available.

### Motion

- Motion demonstrates sequence, state, or provenance; it does not decorate idle chrome.
- Use transform and opacity for entry effects.
- Keep one pinned narrative section and one canvas provenance surface as the site-wide budget established by ADR-0092.
- Respect `prefers-reduced-motion` in JavaScript as well as CSS. Reduced motion renders a complete static state, not an empty start frame.

## Do's and Don'ts

### Do

- **Do** connect every marketing claim to visible product evidence or a source.
- **Do** reuse the same signature task across homepage demonstrations.
- **Do** use generous section rhythm and wide headline measures.
- **Do** test English and Chinese at desktop and mobile widths.
- **Do** preserve keyboard access, meaningful landmarks, and visible focus.

### Don't

- **Don't** invent testimonials, customer logos, performance metrics, release availability, or platform support.
- **Don't** use generic AI imagery, decorative model-logo walls, or scrolling partner marquees.
- **Don't** stack rounded cards inside rounded cards.
- **Don't** hide essential content until hover, animation completion, or JavaScript hydration.
- **Don't** add a second animation runtime or font family without revising the design decision first.
- **Don't** copy Impeccable's own brand; use Impeccable to enforce Cognia's brand.
