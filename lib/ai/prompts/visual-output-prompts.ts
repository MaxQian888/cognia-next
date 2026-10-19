/**
 * The visual-output routing section (ADR-0139).
 *
 * Cognia can render a picture five different ways — a mermaid fence inline in
 * the reply, a chart artifact in the dock, an A2UI surface, a canvas document,
 * and a self-contained HTML+SVG figure from the `diagram-design` skill — and
 * until now nothing told a model the difference. The observed result was
 * arbitrary: hand-drawn SVG where a live chart belonged, a chart artifact
 * emitted into an IM thread that has no dock to open it in, a static diagram
 * where the reader needed to choose something.
 *
 * So the routing lives in the system prompt rather than in a skill. A skill is
 * only read when the model thinks to load one, and "which surface should this
 * be?" is a question it has to answer *before* it knows a skill exists. The
 * per-channel contracts stay in the skills, where they belong and where they
 * cost nothing until needed, and only the routing is resident.
 *
 * A fact earns a place here, rather than in a skill, when either it applies on
 * a channel that gets no skill at all, or breaking it fails silently and the
 * model could not have recovered the rule from a tool's JSON schema.
 *
 * That is why two Mermaid rules sit in the table below. `diagram-design` is
 * gated on `artifact-authoring`, so it is never delivered to an IM thread, and
 * an IM thread is the one channel where Mermaid is the only surface left. An
 * unquoted label renders an error card, and a pinned palette is unreadable in
 * the other theme, and neither is guessable. By the same rule the canvas
 * `language` and `type` enums are NOT here: the tool schema already carries
 * them. What no schema says is "read it before you rewrite it".
 *
 * Deliberately short. This is appended to every send, so it earns its budget by
 * being a decision table and nothing else.
 *
 * Every rule's wording is editable in the Prompt Center (ADR-0236), one entry
 * per channel-dependent block. Which blocks a send gets is decided here from
 * the channel set, never by prompt text: an override can reword a route but
 * cannot offer a surface this channel lacks.
 */

import { resolvePrompt } from "@/lib/prompts/resolve"
import type { PromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import {
  definePrompt,
  type PromptDefinitionInput,
  type PromptDefinitionV1,
  type PromptResolutionContext,
} from "@/lib/prompts/types"

export interface VisualOutputChannels {
  /**
   * The artifact dock is reachable, so chart / html / canvas artifacts have
   * somewhere to open. False for a session bound to an IM connector, where a
   * fenced artifact arrives as raw text.
   */
  artifacts: "tools" | "fenced" | "disabled"
  /** A2UI surfaces are enabled for this send. */
  a2ui: boolean
  /**
   * ADR-0218 — the reply is drawn by Cognia's own markdown renderer (no IM
   * binding, not the CLI) and `messageDisplay.markdown.charts` is on, so a
   * fenced `chart` block draws inline. Absent means false.
   */
  inlineCharts?: boolean
}

const VISUAL_OUTPUT_SHARED = {
  contractVersion: 1,
  kind: "feature-template",
  group: "chat",
  operation: "replace-template",
  scopes: ["account", "workspace", "agent", "session"],
  activation: "next-operation",
  hosts: ["app", "cli"],
  maxChars: 4_000,
  consumers: ["lib/ai/prompts/visual-output-prompts.ts"],
} as const satisfies Partial<PromptDefinitionInput>

/**
 * The section itself: the heading, the structural (Mermaid) route that every
 * channel renders, the channel's own routes, and the precise-values rule.
 */
export const VISUAL_OUTPUT_FRAME_PROMPT = definePrompt({
  ...VISUAL_OUTPUT_SHARED,
  id: "chat.visual-output.frame",
  risk: "ordinary",
  maxChars: 8_000,
  variables: [{ name: "channelRules", required: true, maxChars: 50_000 }],
  outputContract:
    "Appended to the system prompt on every send. {{channelRules}} is the host-chosen set of routes this channel can render, one rule per line.",
  defaultBody: [
    "## Choosing how to show something",
    "",
    "Route by what the thing IS, then by what this channel can render.",
    "",
    "- **Structural** — architecture, a flow, a sequence, a state machine, a data",
    "  model, a timeline: a fenced `mermaid` block inline in the reply. It renders",
    "  in place and needs no dock. Quote any label containing punctuation",
    '  (`A["Auth (v2)"]`), and set no colours and no `%%{init}%%` — Cognia',
    "  re-themes the diagram on a light/dark flip. For a presentation-quality",
    "  figure instead, load the `diagram-design` skill.",
    "{{channelRules}}",
    "- **Precise values** the reader will read off or copy: a markdown table. Three",
    "  numbers are a sentence, not a chart.",
  ].join("\n"),
})

/** The artifact dock is reachable and its authoring tools are offered. */
export const VISUAL_OUTPUT_DOCK_PROMPT = definePrompt({
  ...VISUAL_OUTPUT_SHARED,
  id: "chat.visual-output.dock",
  risk: "ordinary",
  outputContract: "Included when the artifact tools are available on this send.",
  defaultBody: [
    "- **Quantitative** — a trend, a comparison, a share of a total, a correlation:",
    '  call `artifact_create` with `type: "chart"`. It opens in the dock themed,',
    "  hoverable, versioned and exportable as PNG or PDF. Load the `chart-design`",
    "  skill for the data contract before the first one.",
    "- **Something the reader will keep editing** — a document, a spec, a draft they",
    "  will iterate on with you: `canvas_create`. `canvas_update` rewrites the whole",
    "  buffer, so `canvas_read` first and send the document back complete.",
    "- Use `artifact_update` to revise an artifact rather than re-emitting it, so the",
    "  reader keeps its history and reviews your change as a diff.",
    "- Never hand-draw a chart as SVG while the dock is available. A drawing is a",
    "  picture of a chart; the artifact is the chart.",
  ].join("\n"),
})

/** The dock is reachable only through a fenced payload Cognia's detector lifts. */
export const VISUAL_OUTPUT_FENCED_PROMPT = definePrompt({
  ...VISUAL_OUTPUT_SHARED,
  id: "chat.visual-output.fenced",
  // The fenced payload is read by the artifact detector.
  risk: "protocol",
  requiredFragments: ['"type"'],
  outputContract:
    'Included when artifacts arrive as fenced payloads. The detector lifts a `json` fence holding {"type", "data"} into the dock.',
  defaultBody: [
    "- **Quantitative**: emit one supported fenced chart payload for Cognia's",
    '  detector to lift into the dock: a `json` fence holding `{"type":"bar",',
    '  "data":[…]}`. Name the `type` or the dock draws a line chart whatever the',
    "  rows say. Rows are `{name,value}`, or `{x,y}` for scatter. Do not name",
    "  unavailable artifact tools, and never expose raw JSON or HTML outside the",
    "  fenced payload.",
    "- **Editable documents**: answer inline; direct canvas authoring is unavailable.",
  ].join("\n"),
})

/**
 * The inline chart line. The payload is `chart-design`'s contract verbatim;
 * the renderer that draws it (`components/chat/renderers/chart-block.tsx`)
 * and the dock artifact read it through the same `parseChartPayload`.
 */
export const VISUAL_OUTPUT_INLINE_CHART_PROMPT = definePrompt({
  ...VISUAL_OUTPUT_SHARED,
  id: "chat.visual-output.inline-chart",
  // The fenced `chart` block is parsed by parseChartPayload.
  risk: "protocol",
  requiredFragments: ["`chart`"],
  outputContract:
    "Included when Cognia's own renderer draws the reply and inline charts are on. A fenced `chart` block is parsed by parseChartPayload.",
  defaultBody: [
    "- **A quick quantitative aside** the reader only needs to see: a fenced `chart` block",
    '  holding the chart JSON (`{"type":"bar","data":[…]}`). It draws inline, themed.',
  ].join("\n"),
})

/** No dock and no inline chart, but A2UI is on for this send. */
export const VISUAL_OUTPUT_NO_DOCK_A2UI_CHART_PROMPT = definePrompt({
  ...VISUAL_OUTPUT_SHARED,
  id: "chat.visual-output.no-dock-a2ui-chart",
  risk: "ordinary",
  outputContract: "Included when no artifact route exists and A2UI surfaces are enabled.",
  defaultBody: [
    "- **Quantitative**: prefer an A2UI Chart when this channel supports it; otherwise",
    "  use a compact markdown table. There is no artifact dock or permitted authoring",
    "  route here, so never emit raw chart JSON or HTML.",
  ].join("\n"),
})

/** No dock, no inline chart and no A2UI. */
export const VISUAL_OUTPUT_NO_DOCK_TABLE_PROMPT = definePrompt({
  ...VISUAL_OUTPUT_SHARED,
  id: "chat.visual-output.no-dock-table",
  risk: "ordinary",
  outputContract: "Included when no artifact route, inline chart or A2UI surface exists.",
  defaultBody: [
    "- **Quantitative**: use a compact markdown table. There is no artifact dock or",
    "  permitted authoring route here, so never emit raw chart JSON or HTML.",
  ].join("\n"),
})

/** Every send without an artifact route: documents are answered inline. */
export const VISUAL_OUTPUT_NO_CANVAS_PROMPT = definePrompt({
  ...VISUAL_OUTPUT_SHARED,
  id: "chat.visual-output.no-canvas",
  risk: "ordinary",
  outputContract: "Included whenever artifact authoring is unavailable on this send.",
  defaultBody: "- **Editable documents**: answer inline; do not emit a canvas payload.",
})

/** A2UI is on for this send. */
export const VISUAL_OUTPUT_INTERACTIVE_PROMPT = definePrompt({
  ...VISUAL_OUTPUT_SHARED,
  id: "chat.visual-output.interactive",
  risk: "ordinary",
  outputContract: "Included when A2UI surfaces are enabled on this send.",
  defaultBody: [
    "- **Interactive** — the reader has to choose, confirm, filter or submit: an",
    "  A2UI surface, not a picture of one.",
  ].join("\n"),
})

/** Every definition this section draws from, for the catalog. */
export const VISUAL_OUTPUT_PROMPTS: readonly PromptDefinitionV1[] = [
  VISUAL_OUTPUT_FRAME_PROMPT,
  VISUAL_OUTPUT_DOCK_PROMPT,
  VISUAL_OUTPUT_FENCED_PROMPT,
  VISUAL_OUTPUT_INLINE_CHART_PROMPT,
  VISUAL_OUTPUT_NO_DOCK_A2UI_CHART_PROMPT,
  VISUAL_OUTPUT_NO_DOCK_TABLE_PROMPT,
  VISUAL_OUTPUT_NO_CANVAS_PROMPT,
  VISUAL_OUTPUT_INTERACTIVE_PROMPT,
]

export interface VisualOutputPromptOptions {
  /** The turn's resolution context (session, workspace, agent). */
  context?: PromptResolutionContext
  /** The turn's frozen override snapshot; omitted, the loaded one is read. */
  snapshot?: PromptOverrideSnapshot | null
}

/**
 * Build the routing section, or `null` when there is nothing to route — which
 * cannot currently happen (a mermaid fence renders everywhere), but keeps the
 * caller's append site honest if a future channel set is empty.
 */
export function buildVisualOutputSection(
  channels: VisualOutputChannels,
  options: VisualOutputPromptOptions = {}
): string | null {
  const render = (def: PromptDefinitionV1, values?: Readonly<Record<string, string>>) =>
    resolvePrompt(def, {
      ...(options.context ? { context: options.context } : {}),
      ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
      ...(values ? { values } : {}),
    }).text

  const rules: PromptDefinitionV1[] = []
  if (channels.artifacts === "tools") {
    rules.push(VISUAL_OUTPUT_DOCK_PROMPT)
    if (channels.inlineCharts) rules.push(VISUAL_OUTPUT_INLINE_CHART_PROMPT)
  } else if (channels.artifacts === "fenced") {
    rules.push(VISUAL_OUTPUT_FENCED_PROMPT)
    if (channels.inlineCharts) rules.push(VISUAL_OUTPUT_INLINE_CHART_PROMPT)
  } else if (channels.inlineCharts) {
    // A Cognia chat surface whose user turned artifact authoring off: no dock,
    // but the transcript still draws an inline chart, which is not an artifact.
    rules.push(VISUAL_OUTPUT_INLINE_CHART_PROMPT, VISUAL_OUTPUT_NO_CANVAS_PROMPT)
  } else {
    // An A2UI Chart is offered only when A2UI is on for this send: a bot that
    // opted out of interactive cards has no A2UI tools to draw one with.
    rules.push(
      channels.a2ui ? VISUAL_OUTPUT_NO_DOCK_A2UI_CHART_PROMPT : VISUAL_OUTPUT_NO_DOCK_TABLE_PROMPT,
      VISUAL_OUTPUT_NO_CANVAS_PROMPT
    )
  }

  if (channels.a2ui) rules.push(VISUAL_OUTPUT_INTERACTIVE_PROMPT)

  if (rules.length === 0) return null
  return render(VISUAL_OUTPUT_FRAME_PROMPT, {
    channelRules: rules.map((def) => render(def)).join("\n"),
  })
}
