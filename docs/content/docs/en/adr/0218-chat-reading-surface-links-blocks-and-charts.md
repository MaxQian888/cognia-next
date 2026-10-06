---
title: "0218 — The chat reading surface: links, rich blocks and inline charts"
description: "Assistant prose, links and rich blocks share one set of reading tokens and one block frame, so a turn reads the same while it streams and after it finalises. External links carry a site mark and open a preview card on hover (tap on touch) in messages and in the composer; previews are fetched through the platform transport on the desktop and mobile shells, behind the SSRF and PII guards, and degrade to a local card in the browser build. A fenced `chart` block draws an inline chart from the existing chart contract. Text size, paragraph spacing, link style, previews, block density, code height and the code theme become message-display settings."
---

# ADR 0218 — The chat reading surface: links, rich blocks and inline charts

**Status:** Accepted
**Date:** 2026-10-06
**Amends:** [ADR-0127](./0127-chat-render-transport-efficiency) (§4: the message-display contract gains `reading`, `links` and four `markdown` fields, and the Shiki theme becomes a setting), [ADR-0139](./0139-visual-output-routing) (the routing table gains an inline chart fence)
**Related:** [ADR-0060](./0060-personal-knowledge-capture-and-insights) (web reader), [ADR-0094](./0094-conversation-anchors-and-jump), [ADR-0114](./0114-chat-message-presentation)

## Context

A side-by-side audit of the two markdown branches (streaming through Streamdown, finalised through
react-markdown) and every block renderer under `components/chat/renderers/` found four problems.

**Links barely read as links.** A web link was `text-primary` plus typeset's 30 % underline. In the
default theme `--primary` is a neutral near-black, so a link differed from body text only by weight.
There was no site mark, no visited or external affordance, and nothing on hover. File links used a
second, stronger underline. The composer already folds a pasted URL into a brand icon and a short
label (`lib/chat/link-fold.ts`, `lib/chat/link-display.ts`), so the composer showed more about a link
than the message it produced.

**Blocks shared no chrome.** Code, diff, mermaid, math, tables, images and alerts each drew their own
frame. Toolbar buttons came in five sizes and three placements (header row, overlay, a separate row
above tables). Radii were `md`, `lg` or `xl`, margins `my-2` to `my-4`, and there were four fullscreen
implementations and three error styles. Alert, task-list and diff colours were raw Tailwind hues.
Tables used `px-4 py-2` cells in a collapsed square grid with a 28 px toolbar row that never hid.

**Streaming and finalised blocks differed.** Streamdown drew code as a card inside a card with a
400 px cap and drew mermaid with its stock light theme in monospace, so both visibly re-laid-out when
a turn finalised. Mermaid ignored the app's palette in both branches.

**There was no inline chart.** ADR-0139 routes quantitative answers to a chart artifact in the dock.
That fits a chart the reader will keep, export or revise. A quick comparison inside an answer still
had to leave the transcript, or became a table.

## Decision

### 1. Reading tokens

`app/globals.css` gains a `--link` token (light and dark, tuned for 4.5:1 on the background), next
to the `--mark` token that the P0 fix added. Custom themes can set both through the theme token
catalog. There is no visited colour: chat links open in the OS browser or a browser pane, so the
WebView's history never records them and a visited state could not be shown truthfully. Assistant
prose reads them through attributes on the message shell, set from the resolved display options:

| Attribute | Values | Effect |
| --- | --- | --- |
| `data-chat-text-size` | `sm`, `md`, `lg` | `--typeset-size` 13 / 14 / 15 px at the chat column's 14 px base |
| `data-chat-spacing` | `compact`, `comfortable`, `relaxed` | `--typeset-flow` 0.75 / 1 / 1.25 em |
| `data-link-color` | `link`, `primary`, `text` | link colour: the `--link` token, `--primary`, or inherited text |
| `data-link-underline` | `subtle`, `solid`, `hover` | underline at 30 %, at full strength, or only on hover |
| `data-block-density` | `compact`, `comfortable` | block padding, table cell padding, block margins |
| `data-code-max-height` | `short`, `medium`, `tall`, `none` | `--rich-code-max-h` 16 / 24 / 36 rem or uncapped, in both branches |
| `data-block-border` | `on`, `off` | off makes the frame border transparent; code and diff bodies keep their tint |
| `data-block-header` | `on`, `off` | off hides the header bar's icon, label and meta and floats its actions inside the block as the overlay pill |

Web links and file links share one style. Defaults are `md`, `comfortable`, `link`, `subtle` and
`compact`, so the only default change is that links take a real link colour and blocks get tighter.

### 2. Link presentation and previews

An external link in a message renders through `ChatLink`'s fallback branch (plugin link matchers
still win). It gains a leading site mark, chosen in order:

1. a local brand icon when `brandIdForHost` knows the host (works offline and under the desktop CSP);
2. the site's favicon, when previews may fetch;
3. a generic globe glyph.

A preview card opens after a short hover delay on pointer devices and on tap-and-hold through a
popover on touch, following `session-environment-chip.tsx`. The composer opens the same card over a
folded link: the overlay is `pointer-events: none`, so the textarea hit-tests the overlay's
`[data-chip="link"]` rects and anchors the card with a virtual `PopoverAnchor`.

Metadata comes from `lib/web/link-preview/`:

- **Transport:** `createPlatformFetch()` (Tauri `proxy_http_request`, Capacitor native HTTP), with
  private hosts blocked. The browser build cannot read cross-origin pages without a server, and
  `app/api` does not exist at runtime, so it does not fetch. It shows the local card: site mark, host,
  the `describeLink` label and the path.
- **Guards:** only `http`/`https`; `assertFetchTargetAllowed`; a URL that fails the PII scan used by
  `lib/chat/link-context.ts` is never fetched.
- **Parsing:** the document head is parsed with the WebView's `DOMParser` for Open Graph, Twitter
  card, `<title>`, description, `theme-color` and icon links. `packages/document`'s cheerio parser is
  not used, so a hover never loads cheerio, and that parser does not read icons or `og:site_name`.
  Reads stop at 512 KiB or at `</head>`, with an 8 s timeout. A non-HTML response becomes a basic card
  that names its type; an image URL previews itself.
- **Images:** the desktop CSP allows only `self`, `data:` and `blob:` images, so on Tauri `og:image`
  and favicons are fetched through the same transport (4 MiB cap, image types only) and shown as
  `data:` URLs. A `data:` URL needs no revocation, so an evicted entry cannot break an image that is
  still on screen. Capacitor loads them directly.
- **Cache:** in memory only. An LRU of 200 metadata entries, a 30-minute TTL for successes and
  5 minutes for failures, and shared in-flight requests. Image data URLs sit in a second LRU weighted
  by size and capped at 24 MB. No Dexie table: a preview is cheap to refetch and not worth a schema
  bump.
- **Streaming:** a link inside a turn that is still streaming does not fetch; it shows the local card.

Settings: `links.preview` (`hover` or `off`) and `links.siteIcon` (on or off). With previews off,
nothing about a link is fetched and the site mark falls back to brand icon or globe.

### 3. One block frame

`components/chat/renderers/rich-block/` owns the frame every block uses:

- `RichBlockFrame`: `rounded-lg border bg-card`, a 32 px header with a kind icon, a label and an
  action area. Actions are `RichBlockAction` (one 24 px icon button with tooltip) and honour
  `data-message-rich-control`, so the rich-controls setting hides or hover-reveals them everywhere,
  images and diffs included.
- `RichBlockFullscreen`: the responsive dialog/drawer that code already used, now shared by tables,
  mermaid, math and charts.
- `RichBlockError`: the one destructive state.

`markdown.blockBorder` and `markdown.blockHeader` (both on by default) let a reader drop the chrome.
Turning headers off never removes a toolbar: the header element stays in the DOM, its title parts
hide, and its actions float inside the block as the same pill that overlay frames and images use,
under the same hover-reveal classes. Both act through shell attributes and unlayered CSS on the
frame's `data-rich-block-header` / `-title` / `-actions` hooks and Streamdown's code-block hooks, so
the streaming and finalised branches change together. A chart's payload title lives in the header,
so with headers off it remains only as the figure's accessible name.

Tables move their actions into a hover overlay on the frame instead of a row above it, use a
separated grid with rounded corners, a tinted header, row hover and right-aligned numeric columns.
Alert, task-list and diff colours move to `--info`, `--success`, `--warning` and `--destructive`.

The streaming branch keeps Streamdown's incremental Shiki highlighting. Its code-block chrome is
restyled through its stable `data-streamdown` attributes to the same frame, and its height cap follows
`markdown.codeMaxHeight`. Mermaid and `chart` fences are registered as Streamdown custom renderers
(`components/chat/markdown/streaming-fence-renderers.tsx`), which Streamdown consults before its
built-in mermaid card, so a streaming diagram is the same `MermaidBlock` the finalised message mounts.
While a fence is still open it shows a sized placeholder in the same frame. Mermaid uses the `base`
theme with `themeVariables` resolved from the app tokens at render time (as sRGB hex, because
mermaid's colour maths cannot read `oklch`) and the app's sans font, so diagrams follow the palette
and the light/dark flip in both branches. The render cache keys on the resolved palette. Fullscreen
diagrams get zoom steps but no PNG export: mermaid draws labels in `foreignObject`, which taints a
canvas.

### 4. Inline charts

A fenced `chart` block holds the payload `lib/artifacts/chart-contract.ts` already defines.
`parseChartPayload` stays the single answer to what a payload means; the inline block and the
artifact renderer share the drawing code. Series colours come from `--chart-1` to `--chart-5`
instead of recharts' demo hex values. The block offers a data table view, copy-as-JSON, PNG export
and fullscreen. While the fence is still streaming it shows a sized placeholder and draws once the
fence closes (Streamdown's `renderers` hook on the streaming branch, the `code` override on the
finalised one). `markdown.charts` turns it off, in which case the fence renders as JSON code.
The artifact detector (`lib/ai/generation/artifact-detector.ts`) skips `chart` fences, so an inline
chart never also becomes a dock artifact.

The ADR-0139 routing section gains an `inlineCharts` channel flag, true when the reply is rendered by
Cognia's markdown (no IM binding, not the CLI) and `markdown.charts` is on. It then offers the fence
for a small quantitative aside and keeps the artifact for a chart the reader will keep, export or
revise. IM threads are unchanged.

### 5. Settings

`MessageDisplayOverrides` gains:

```ts
reading?: { textSize?: "sm" | "md" | "lg"; spacing?: "compact" | "comfortable" | "relaxed" }
links?: {
  color?: "link" | "primary" | "text"
  underline?: "subtle" | "solid" | "hover"
  siteIcon?: boolean
  preview?: "hover" | "off"
}
markdown?: {
  // ADR-0127 fields, plus:
  charts?: boolean
  blockDensity?: "compact" | "comfortable"
  blockBorder?: boolean
  blockHeader?: boolean
  codeMaxHeight?: "none" | "short" | "medium" | "tall"
  codeTheme?: ChatCodeThemeId
}
```

Resolution stays in `resolveMessageDisplayOptions` (session → global → preset), and every preset
supplies the defaults above. The controls join `MessageDisplayControls`, which the desktop appearance
tab, the session sheet and the mobile settings panel all mount.

**Code theme.** ADR-0127 kept the Shiki theme hard-coded because both renderers must agree. They
still must, so the setting picks a curated light/dark pair from `CHAT_CODE_THEMES`
(`lib/chat/code-theme.ts`) and both branches read the resolved pair. The streaming plugin set is
memoised per pair and the finalised highlight cache keys on it. The tool-approval code surface keeps
the default pair.

## Consequences

- Links look different by default. The `link` token is tuned to pass 4.5:1 against both
  backgrounds, and a theme that wants the old look sets `color: primary`.
- Hovering a link on desktop or mobile fetches that page, which is a request to a host the model
  named. It runs only behind the guards above, never during streaming, and `links.preview: off`
  stops it.
- Every block renderer depends on `RichBlockFrame`, so a chrome change is made once.
- Streaming code blocks depend on Streamdown's `data-streamdown` attributes. The renderer test pins
  the attribute names, so a Streamdown upgrade that renames them fails a test instead of the layout.

## Implementation status

| Part | State |
| --- | --- |
| P0 fixes (fonts reach prose and code, alert structure, inline code parity, `mark`/`u`/`abbr`, chart tooltip) | Landed in `c8cdaf667` |
| §1–§5: reading tokens, link presentation and previews, block frame, streaming parity, mermaid theming, inline charts and routing, settings | Landed |
