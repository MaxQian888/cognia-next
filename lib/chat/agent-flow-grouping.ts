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
  | { kind: "single"; entry: PartEntry<P> }
  | { kind: "group"; entries: PartEntry<P>[] }

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
    const type = part?.type
    // Sub-agent parts render separately as a tree — skip without breaking runs.
    if (type === "subagent") return
    if (isGroupableToolType(type)) {
      run.push({ part, index })
      return
    }
    flush()
    segments.push({ kind: "single", entry: { part, index } })
  })
  flush()

  return segments
}
