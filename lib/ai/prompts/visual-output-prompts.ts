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
 */

export interface VisualOutputChannels {
  /**
   * The artifact dock is reachable, so chart / html / canvas artifacts have
   * somewhere to open. False for a session bound to an IM connector, where a
   * fenced artifact arrives as raw text.
   */
  artifacts: "tools" | "fenced" | "disabled"
  /** A2UI surfaces are enabled for this send. */
  a2ui: boolean
}

/**
 * Build the routing section, or `null` when there is nothing to route — which
 * cannot currently happen (a mermaid fence renders everywhere), but keeps the
 * caller's append site honest if a future channel set is empty.
 */
export function buildVisualOutputSection(channels: VisualOutputChannels): string | null {
  const lines: string[] = [
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
  ]

  if (channels.artifacts === "tools") {
    lines.push(
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
      "  picture of a chart; the artifact is the chart."
    )
  } else if (channels.artifacts === "fenced") {
    lines.push(
      "- **Quantitative**: emit one supported fenced chart payload for Cognia's",
      '  detector to lift into the dock: a `json` fence holding `{"type":"bar",',
      '  "data":[…]}`. Name the `type` or the dock draws a line chart whatever the',
      "  rows say. Rows are `{name,value}`, or `{x,y}` for scatter. Do not name",
      "  unavailable artifact tools, and never expose raw JSON or HTML outside the",
      "  fenced payload.",
      "- **Editable documents**: answer inline; direct canvas authoring is unavailable."
    )
  } else {
    lines.push(
      "- **Quantitative**: prefer an A2UI Chart when this channel supports it; otherwise",
      "  use a compact markdown table. There is no artifact dock or permitted authoring",
      "  route here, so never emit raw chart JSON or HTML.",
      "- **Editable documents**: answer inline; do not emit a canvas payload."
    )
  }

  if (channels.a2ui) {
    lines.push(
      "- **Interactive** — the reader has to choose, confirm, filter or submit: an",
      "  A2UI surface, not a picture of one."
    )
  }

  lines.push(
    "- **Precise values** the reader will read off or copy: a markdown table. Three",
    "  numbers are a sentence, not a chart."
  )

  return lines.length > 3 ? lines.join("\n") : null
}
