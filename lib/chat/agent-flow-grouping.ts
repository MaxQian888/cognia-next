/**
 * Pure segmentation of an assistant message's parts into render segments for
 * the agent-flow display: runs of ≥2 consecutive tool calls collapse into one
 * "activity group", everything else stays a single segment.
 *
 * Grouping is *mode-aware*. In `standard` / `detailed` every tool (bar
 * TodoWrite) folds. In `simplified` only context-gathering reads fold (the
 * TUI's `groupContextRuns` philosophy) — see {@link isContextFoldPart} — so
 * edits, writes and commands stand as their own prominent rows.
 *
 * Sub-agent parts are transparent to grouping — they render once as a dispatch
 * tree at the message level, so they neither join nor break a tool run.
 * `TodoWrite` is excluded because it renders as a structured plan, not a card.
 */

import { isContextFoldPart } from "./tool-summary"
import type { AgentFlowMode } from "@/types/appearance"

export const MIN_GROUP_SIZE = 2

export interface PartEntry<P> {
  part: P
  /** Original index in `message.parts` (used for stable keys). */
  index: number
}

export type AgentFlowSegment<P> =
  { kind: "single"; entry: PartEntry<P> } | { kind: "group"; entries: PartEntry<P>[] }

/**
 * True for any tool-call part type — `tool-*`, plus the AI SDK's
 * `dynamic-tool` shape for a tool the client never declared statically (it
 * carries the name on `part.toolName`). Both reach the renderer: imported
 * sessions and CLI handoff transcripts can hold `dynamic-tool` parts.
 */
export function isToolPartType(type: string | undefined): boolean {
  return typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool")
}

/** True for tool parts that participate in activity grouping. */
export function isGroupableToolType(type: string | undefined): boolean {
  if (!isToolPartType(type)) return false
  // TodoWrite renders as a plan list, not a tool card. Only the two statically
  // declared spellings are special-cased in the renderer, so only those are
  // excluded here — a `dynamic-tool` named TodoWrite renders as an ordinary
  // tool card and must keep folding with its neighbours.
  return type !== "tool-TodoWrite" && type !== "tool-mcp__cognia-tools__TodoWrite"
}

/** Part-level companion to {@link isGroupableToolType}. */
export function isGroupableToolPart<P extends { type?: string }>(part: P): boolean {
  return isGroupableToolType(part?.type)
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

export function groupAgentParts<P extends { type?: string }>(
  parts: P[],
  mode: AgentFlowMode = "standard"
): AgentFlowSegment<P>[] {
  // Simplified mode adopts the TUI's selective folding: only context-gathering
  // reads (read/search/glob/list/web) fold; every other tool breaks the run and
  // stands alone. Standard/detailed keep the "any tool folds" behaviour.
  //
  // Both predicates take the whole part, not its type: `dynamic-tool` carries
  // its name on `toolName`, so a type-only check would silently refuse to fold
  // every imported / CLI-handoff read burst in simplified mode.
  const isGroupable: (part: P) => boolean =
    mode === "simplified" ? isContextFoldPart : isGroupableToolPart

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
    if (isGroupable(part)) {
      run.push({ part, index })
      return
    }
    flush()
    segments.push({ kind: "single", entry: { part, index } })
  })
  flush()

  return segments
}
