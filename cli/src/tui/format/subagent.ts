/**
 * Pure helpers for presenting sub-agent dispatches as first-class units rather
 * than opaque tool cards. A sub-agent call (the `task` / `dispatch_agent` /
 * `agent` tools) still travels through the normal ToolCell pipeline
 * (TOOL_CALL → inflight.tools → cells); these helpers let the renderer pick it
 * out and pull a readable agent name + task description from the tool input, and
 * let the footer summarize the dispatches currently in flight. No Ink, no I/O.
 */
import type { ToolCell } from "../state/types"

/** The tool names that dispatch a sub-agent (case-insensitive). */
const SUBAGENT_TOOLS = new Set(["task", "dispatch_agent", "agent"])

/** Whether a tool name is a sub-agent dispatch (`task` / `dispatch_agent` / `agent`). */
export function isSubagentTool(toolName: string): boolean {
  return SUBAGENT_TOOLS.has(toolName.toLowerCase())
}

/** First non-empty string among the candidate keys, trimmed to `max` chars. */
function pick(input: Record<string, unknown>, keys: string[], max: number): string | undefined {
  for (const key of keys) {
    const v = input[key]
    if (typeof v === "string" && v.trim().length > 0) {
      const s = v.trim()
      return s.length > max ? s.slice(0, max - 1) + "…" : s
    }
  }
  return undefined
}

/** The dispatched agent's id/type, or "agent". */
export function subagentName(input: Record<string, unknown>): string {
  return pick(input, ["subagent_type", "subagentId", "subagent_id", "agent", "name"], 40) ?? "agent"
}

/** The task handed to the sub-agent — its `description`, falling back to the prompt. */
export function subagentTask(input: Record<string, unknown>): string {
  return pick(input, ["description", "prompt"], 120) ?? ""
}

/**
 * Summarize the sub-agent dispatches still running among a turn's in-flight
 * tools, for the footer indicator. Returns the most recent running one's name
 * plus how many are running, or `null` when none are.
 */
export function runningSubagents(tools: ToolCell[]): { name: string; count: number } | null {
  const running = tools.filter((t) => t.status === "running" && isSubagentTool(t.toolName))
  if (running.length === 0) return null
  return { name: subagentName(running[running.length - 1].input), count: running.length }
}

/** One in-turn sub-agent dispatch still running, distilled for the agents panel. */
export interface InflightSubagentRow {
  /** The tool cell's correlation key — stable id for the panel row. */
  callKey: string
  name: string
  task: string
}

/**
 * All sub-agent dispatches still running among a turn's in-flight tools, each as
 * a {@link InflightSubagentRow}. Unlike {@link runningSubagents} (a footer
 * summary) this keeps every row so the agents panel can list them individually.
 */
export function inflightSubagentRows(tools: ToolCell[]): InflightSubagentRow[] {
  return tools
    .filter((t) => t.status === "running" && isSubagentTool(t.toolName))
    .map((t) => ({ callKey: t.callKey, name: subagentName(t.input), task: subagentTask(t.input) }))
}
