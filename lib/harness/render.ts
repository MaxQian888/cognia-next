/**
 * How an agent's harness sections reach a run (ADR-0237).
 *
 * `resolveSendOptions` calls these for every turn of an agent that carries
 * `Character.harness`, and for every probe (whose ephemeral agent carries the
 * candidate's harness). Normal runs and probes therefore render a harness
 * through exactly the same code.
 */

import type { CharacterHarness } from "@cognia/agent-config-types/agent-harness"
import type { AgentDefinition } from "@cognia/agent-config-types/claude-agent-sdk-options"

/**
 * The always-on harness block appended after the agent's persona. Empty
 * sections are omitted, and an empty harness renders nothing.
 */
export function renderHarnessSections(harness: CharacterHarness | undefined | null): string {
  if (!harness) return ""
  const parts: string[] = []
  const guardrails = harness.guardrails?.trim()
  const memory = harness.memory?.trim()
  const toolGuidance = harness.toolGuidance?.trim()
  if (guardrails) parts.push(`## Standing rules\n\n${guardrails}`)
  if (memory) parts.push(`## Domain facts\n\n${memory}`)
  if (toolGuidance) parts.push(`## Tool guidance\n\n${toolGuidance}`)
  return parts.join("\n\n")
}

/**
 * Narrow a subagent's tools to what its parent may use. With a parent allow
 * list, the subagent keeps only tools on it (its own list, or the parent's when
 * it declared none); the parent's denials always carry over.
 */
export function clampSubagentTools(
  def: AgentDefinition,
  parentAllowed: readonly string[] | undefined,
  parentDenied: readonly string[] | undefined
): AgentDefinition {
  const denied = new Set(parentDenied ?? [])
  let tools = def.tools
  if (parentAllowed) {
    const allowed = new Set(parentAllowed)
    tools = (tools ?? [...parentAllowed]).filter((t) => allowed.has(t))
  }
  if (tools) tools = tools.filter((t) => !denied.has(t))
  const disallowed = [...new Set([...(def.disallowedTools ?? []), ...denied])]
  return {
    ...def,
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowed.length ? { disallowedTools: disallowed } : {}),
  }
}

/** The harness's subagents as SDK agent definitions, keyed by name. */
export function harnessSubagentDefinitions(
  harness: CharacterHarness | undefined | null
): Record<string, AgentDefinition> {
  const out: Record<string, AgentDefinition> = {}
  for (const sub of harness?.subagents ?? []) {
    if (!sub.name || !sub.description?.trim() || !sub.prompt?.trim()) continue
    out[sub.name] = {
      description: sub.description.trim(),
      prompt: sub.prompt.trim(),
      ...(sub.tools?.length ? { tools: [...sub.tools] } : {}),
    }
  }
  return out
}
