/**
 * The built-in subagents the CLI offers, projected from the shared catalog
 * (`lib/agent/builtin-catalog`, ADR-0161).
 *
 * Why built-ins exist at all: the `dispatch_agent` (Task) tool is only surfaced
 * to the model when there is at least one dispatchable subagent (see
 * `buildCliSubagentToolManifest`). With zero discovered agents the tool is
 * withheld, so a fresh project, which has no `.cognia/agents` dir, gives the
 * model no way to delegate.
 *
 * Why they are no longer written here: this file used to hand-write
 * `general-purpose`, `Explore` and `Plan`, while the app hand-wrote `Explore`,
 * `Plan` and four `workflow-*` agents. The two `Explore` and `Plan` pairs had
 * different prompts and different descriptions, so the same name meant two
 * different agents depending on which shell dispatched it.
 *
 * All of these run as leaves. The runner never re-surfaces `dispatch_agent` to
 * a subagent, so this does not introduce unbounded nesting. The read-only pair
 * backs the plan-mode explore-then-plan flow (system-prompt guidance plus
 * `/plan explore`).
 */

import {
  EXPLORE_AGENT_ID,
  GENERAL_PURPOSE_AGENT_ID,
  PLAN_AGENT_ID,
  builtinAgentById,
  builtinAgentsForSurface,
  resolveBuiltinToolPolicy,
} from "@/lib/agent/builtin-catalog/catalog"
import type { BuiltinAgentEntry } from "@/lib/agent/builtin-catalog/types"
import { type AgentSummary } from "./discover-agents"

export { EXPLORE_AGENT_ID, GENERAL_PURPOSE_AGENT_ID, PLAN_AGENT_ID }

/** Project one catalog entry into the CLI's discovered-agent shape. */
function toSummary(entry: BuiltinAgentEntry): AgentSummary {
  const tools = resolveBuiltinToolPolicy(entry.toolPolicy)
  return {
    id: entry.id,
    name: entry.id,
    description: entry.description,
    def: {
      id: entry.id,
      name: entry.id,
      description: entry.description,
      prompt: entry.prompt,
      // No `tools` means inherit the parent's full toolset, and no `model`
      // means inherit the active provider's model in `buildChildConfig`.
      ...(tools ? { tools } : {}),
      ...(entry.maxTurns !== undefined ? { maxTurns: entry.maxTurns } : {}),
    },
  }
}

/**
 * A factory rather than a frozen const so each caller gets an independent
 * object. Callers carry these into per-turn context maps, and shared mutable
 * identity across sessions is never wanted.
 */
function builtinById(id: string): AgentSummary {
  const entry = builtinAgentById(id)
  if (!entry) throw new Error(`missing built-in agent: ${id}`)
  return toSummary(entry)
}

/** The general-purpose subagent: inherits the parent's model and full toolset. */
export function generalPurposeAgent(): AgentSummary {
  return builtinById(GENERAL_PURPOSE_AGENT_ID)
}

/** The read-only exploration subagent, whitelisted so it cannot mutate. */
export function exploreAgent(): AgentSummary {
  return builtinById(EXPLORE_AGENT_ID)
}

/** The read-only planning subagent. It designs, it never edits. */
export function planAgent(): AgentSummary {
  return builtinById(PLAN_AGENT_ID)
}

/** Every CLI built-in subagent id, for membership checks and introspection. */
export const BUILTIN_AGENT_IDS: ReadonlyArray<string> = builtinAgentsForSurface("cli").map(
  (entry) => entry.id
)

/**
 * Union the discovered (`.cognia/agents/*.md`) subagents with the built-ins,
 * keeping discovered agents first. A user-authored agent whose id collides with
 * a built-in WINS, so `general-purpose.md` on disk customizes the built-in
 * rather than duplicating it. Pure: the input array is never mutated.
 */
export function withBuiltinAgents(discovered: AgentSummary[]): AgentSummary[] {
  const ids = new Set(discovered.map((a) => a.id))
  const builtins = builtinAgentsForSurface("cli")
    .filter((entry) => !ids.has(entry.id))
    .map(toSummary)
  return [...discovered, ...builtins]
}
