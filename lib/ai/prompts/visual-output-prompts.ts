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
 * cost nothing until needed; only the routing is resident.
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
  artifacts: boolean
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
    "  in place and needs no dock. For a presentation-quality figure instead, load",
    "  the `diagram-design` skill.",
  ]

  if (channels.artifacts) {
    lines.push(
      "- **Quantitative** — a trend, a comparison, a share of a total, a correlation:",
      '  a fenced `json` chart artifact (`{"type": …, "data": [{"name": …}]}`), which',
      "  opens in the dock themed, hoverable, versioned and exportable. Load the",
      "  `chart-design` skill for the exact contract before emitting one.",
      "- **Something the reader will keep editing** — a document, a spec, a draft they",
      "  will iterate on with you: a canvas.",
      "- Never hand-draw a chart as SVG while the dock is available. A drawing is a",
      "  picture of a chart; the artifact is the chart."
    )
  } else {
    lines.push(
      "- **Quantitative**: a compact markdown table, or a `mermaid` chart shape. This",
      "  channel has no artifact dock — a chart or canvas artifact arrives as raw",
      "  JSON, so do not emit one."
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
