/**
 * Pure segmentation of an assistant message's parts into render segments for
 * the agent-flow display: runs of ≥2 consecutive tool calls collapse into one
 * "activity group", everything else stays a single segment.
 *
 * Sub-agent parts are transparent to grouping — they render once as a dispatch
 * tree at the message level, so they neither join nor break a tool run.
 * `TodoWrite` is excluded because it renders as a structured plan, not a card.
 */

export const MIN_GROUP_SIZE = 2

export interface PartEntry<P> {
  part: P
  /** Original index in `message.parts` (used for stable keys). */
  index: number
}

export type AgentFlowSegment<P> =
  { kind: "single"; entry: PartEntry<P> } | { kind: "group"; entries: PartEntry<P>[] }

/** True for any `tool-*` part type. */
export function isToolPartType(type: string | undefined): boolean {
  return typeof type === "string" && type.startsWith("tool-")
}

/** True for tool parts that participate in activity grouping. */
export function isGroupableToolType(type: string | undefined): boolean {
  if (!isToolPartType(type)) return false
  // TodoWrite renders as a plan list, not a tool card.
  return type !== "tool-TodoWrite" && type !== "tool-mcp__cognia-tools__TodoWrite"
}

/** AI SDK structural/control part types the renderer draws nothing for. */
export const SILENT_CONTROL_PART_TYPES: ReadonlySet<string> = new Set(["step-start", "step-finish"])

/**
 * True for parts that render nothing inline, so they are transparent to
 * grouping — they neither emit a segment nor break a run.
 *
 * The empty-`text` case is load-bearing: a model that emits no prose between
 * two tool calls still produces a zero-length text part, which would otherwise
 * flush the run and split one activity group into two.
 *
 * Sub-agent parts render once as a dispatch tree at the message level, never
 * inline, so they are transparent here too.
 */
export function isTransparentPart<P extends { type?: string }>(part: P): boolean {
  const type = part?.type
  if (!type) return true
  if (type === "subagent") return true
  if (SILENT_CONTROL_PART_TYPES.has(type)) return true
  if (type === "text") return !((part as { text?: string }).text ?? "").trim()
  return false
}

/**
 * True when a message carries tool calls and nothing a reader could act on —
 * no prose, no artifact, no sources. Such a turn has nothing to copy, quote,
 * read aloud or turn into a card, so the renderer gives it no action bar.
 */
export function isToolOnlyFlow<P extends { type?: string }>(parts: P[]): boolean {
  let sawTool = false
  for (const part of parts) {
    if (isTransparentPart(part)) continue
    if (!isToolPartType(part?.type)) return false
    sawTool = true
  }
  return sawTool
}

export function groupAgentParts<P extends { type?: string }>(parts: P[]): AgentFlowSegment<P>[] {
  const segments: AgentFlowSegment<P>[] = []
  let run: PartEntry<P>[] = []

  const flush = () => {
    if (run.length >= MIN_GROUP_SIZE) {
      segments.push({ kind: "group", entries: run })
    } else {
      for (const entry of run) segments.push({ kind: "single", entry })
    }
    run = []
  }

  parts.forEach((part, index) => {
    if (isTransparentPart(part)) return
    if (isGroupableToolType(part?.type)) {
      run.push({ part, index })
      return
    }
    flush()
    segments.push({ kind: "single", entry: { part, index } })
  })
  flush()

  return segments
}
