// Message importance scoring for the `selective` compaction strategy.
//
// Mirrors the renderer's `MessageImportanceScore` / `ImportanceSignal` shape
// (`types/system/compression.ts`). The sidecar can NOT import `lib/`, so the
// scorer lives here and is injected into `planStrategy` (compaction-strategies.mjs).
// Messages scoring at/above the configured `importanceThreshold` are KEPT
// verbatim by the selective strategy; the rest are summarized.

/** Per-signal weights. `score = min(1, Σ matched weights)`. */
const SIGNAL_WEIGHTS = {
  system: 1.0,
  decision: 0.9,
  code: 0.8,
  error: 0.7,
  recency: 0.6, // scaled by position (0..1)
  "tool-call": 0.5,
  artifact: 0.5,
  question: 0.4,
  "structured-data": 0.4,
  url: 0.3,
}

const DECISION_RE =
  /\b(decide|decided|decision|choose|chose|chosen|agree|agreed|will use|let's use|plan to|going with)\b/i
const ERROR_RE = /\b(error|errors|exception|failed|failure|stack trace|traceback|panic)\b/i
const URL_RE = /https?:\/\/\S+/i
const ARTIFACT_RE =
  /(^|\s|`)[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|rs|py|go|java|c|cpp|h|css|scss|html|yml|yaml|toml|sh)\b/i
const STRUCTURED_RE = /(\{[\s\S]*[:,][\s\S]*\}|\[[\s\S]*\]|(^|\n)\s*\|.*\|)/

/** Flatten a message's content to a plain string for signal detection. */
export function messageText(message) {
  const c = message?.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("")
  }
  return ""
}

/** True when the message represents a tool call or tool result. */
function isToolMessage(message) {
  if (!message) return false
  if (message.role === "tool") return true
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true
  if (Array.isArray(message.content)) {
    return message.content.some(
      (p) =>
        p &&
        (p.type === "tool-call" ||
          p.type === "tool-result" ||
          p.type === "tool_use" ||
          p.type === "tool_result")
    )
  }
  return false
}

/**
 * Score one message in [0,1] with the contributing signals.
 *
 * @param {{role?:string, content?:any, tool_calls?:any[]}} message
 * @param {{ index?: number, total?: number }} [pos]
 * @returns {{ score: number, signals: string[] }}
 */
export function scoreMessage(message, { index = 0, total = 1 } = {}) {
  const signals = []
  const text = messageText(message)

  if (message?.role === "system") signals.push("system")
  if (isToolMessage(message)) signals.push("tool-call")
  if (/```/.test(text) || /\n {4}\S/.test(text)) signals.push("code")
  if (ERROR_RE.test(text)) signals.push("error")
  if (DECISION_RE.test(text)) signals.push("decision")
  if (text.includes("?")) signals.push("question")
  if (URL_RE.test(text)) signals.push("url")
  if (ARTIFACT_RE.test(text)) signals.push("artifact")
  if (STRUCTURED_RE.test(text)) signals.push("structured-data")

  let raw = 0
  for (const s of signals) raw += SIGNAL_WEIGHTS[s] ?? 0

  // Recency: more-recent messages are more important. Always contributes
  // (scaled), and is reported as a signal only when it meaningfully fires.
  const posFraction = total > 1 ? Math.min(1, Math.max(0, index / (total - 1))) : 1
  const recency = SIGNAL_WEIGHTS.recency * posFraction
  if (recency > 0) {
    raw += recency
    if (posFraction >= 0.5) signals.push("recency")
  }

  return { score: Math.min(1, raw), signals }
}
