// Reconstruct an imported Claude Code Task subagent (ADR-0062, T2a-sub).
//
// A subagent's `isSidechain` records are extracted + linearized by
// `claude-code-dag.ts`, then turned into `StoredMessage`s by the shared
// `recordsToMessages`. THIS module is the pure last step: it derives a
// `SubagentPart` snapshot (tool calls / final response / token usage) from those
// already-built messages — the exact shape a natively-run subagent persists, so
// the existing `buildSubagentTree` + `SubagentPart` renderer nests it with zero
// renderer changes. It takes `StoredMessage[]`, never raw records, so it has no
// dependency on the adapter (no import cycle).

import type { StoredMessage } from "@/lib/claude/types"
import type { SubagentPart } from "@/lib/claude/parts-extensions"
import type { SubAgentToolCall, SubAgentTokenUsage } from "@/types/agent/sub-agent"

type PartRecord = Record<string, unknown>

/** Every `tool-<name>` part across the run, as the snapshot's tool-call list. */
export function deriveSubagentToolCalls(messages: StoredMessage[]): SubAgentToolCall[] {
  const calls: SubAgentToolCall[] = []
  for (const m of messages) {
    for (const p of m.parts as PartRecord[]) {
      const type = typeof p.type === "string" ? p.type : ""
      if (!type.startsWith("tool-")) continue
      const name = type.slice("tool-".length)
      const isError = p.state === "output-error"
      calls.push({
        id: typeof p.toolCallId === "string" ? p.toolCallId : `${name}-${calls.length}`,
        name,
        ...(p.input && typeof p.input === "object"
          ? { input: p.input as Record<string, unknown> }
          : {}),
        ...(p.output !== undefined ? { output: p.output } : {}),
        ...(isError ? { isError: true } : {}),
        state: isError ? ("error" as const) : ("done" as const),
      })
    }
  }
  return calls
}

/** The last non-empty assistant text — the subagent's final answer. */
export function deriveSubagentFinalResponse(messages: StoredMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m.role !== "assistant") continue
    const text = (m.parts as PartRecord[])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
    if (text.trim()) return text
  }
  return undefined
}

/** Sum the per-turn token usage carried on the imported messages' metadata. */
export function deriveSubagentTokenUsage(
  messages: StoredMessage[]
): SubAgentTokenUsage | undefined {
  let prompt = 0
  let completion = 0
  let found = false
  for (const m of messages) {
    const usage = (
      m.metadata as { usage?: { inputTokens?: number; outputTokens?: number } } | undefined
    )?.usage
    if (!usage) continue
    found = true
    prompt += usage.inputTokens ?? 0
    completion += usage.outputTokens ?? 0
  }
  if (!found) return undefined
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion }
}

/**
 * Assemble the terminal `SubagentPart` snapshot for an imported subagent run.
 * Mirrors what `subagent-bridge.ts` persists on a real run's terminal
 * transition, so an imported subagent card is indistinguishable from a native
 * one. `nestedSessionId` points at the hidden inner-transcript session.
 */
export function buildSubagentSnapshot(opts: {
  subagentId: string
  parentSessionId: string
  name: string
  nestedSessionId: string
  messages: StoredMessage[]
  startedAt: number
  completedAt?: number
}): SubagentPart {
  const toolCalls = deriveSubagentToolCalls(opts.messages)
  const finalResponse = deriveSubagentFinalResponse(opts.messages)
  const tokenUsage = deriveSubagentTokenUsage(opts.messages)
  return {
    type: "subagent",
    subagentId: opts.subagentId,
    parentSessionId: opts.parentSessionId,
    name: opts.name,
    status: "completed",
    progress: 100,
    startedAt: opts.startedAt,
    ...(opts.completedAt != null ? { completedAt: opts.completedAt } : {}),
    nestedSessionId: opts.nestedSessionId,
    toolCalls,
    toolUses: toolCalls.length,
    ...(finalResponse ? { finalResponse, summary: finalResponse.slice(0, 200) } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
  }
}
