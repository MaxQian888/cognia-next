/**
 * Built-in subagents the CLI always offers, independent of any user-authored
 * `.cognia/agents/*.md` files.
 *
 * Why this exists: the `dispatch_agent` (Task) tool is only surfaced to the model
 * when there is at least one dispatchable subagent (see
 * `buildCliSubagentToolManifest`). With zero discovered agents the tool is
 * withheld, so a fresh project — which has no `.cognia/agents` dir — gives the
 * model no way to delegate at all. Unlike Claude Code, whose `Task` tool ships a
 * `general-purpose` subagent out of the box, the CLI had no built-in fallback.
 *
 * The single built-in here is a `general-purpose` agent that inherits the active
 * provider's model and the parent's full toolset (no `model` / `tools` override),
 * so it can autonomously research and act on any delegated task. It runs as a
 * leaf — the runner never re-surfaces `dispatch_agent` to a subagent — so this
 * does not introduce unbounded nesting.
 */

import { type AgentSummary } from "./discover-agents"

/** Canonical id of the always-available general-purpose subagent. */
export const GENERAL_PURPOSE_AGENT_ID = "general-purpose"

const GENERAL_PURPOSE_DESCRIPTION =
  "General-purpose agent for researching complex questions, searching across the " +
  "codebase, and executing multi-step tasks autonomously. Use when a task is " +
  "open-ended or needs several rounds of searching, reading, and editing — and " +
  "you are not confident the first attempt will land it."

const GENERAL_PURPOSE_PROMPT = `You are a general-purpose subagent dispatched to autonomously complete a delegated task.

You have access to the same tools as the agent that dispatched you (file search, reading, editing, shell, and more). Work the task end to end: search and read whatever you need, take the actions the task requires, and verify your work before you respond.

You run as a single autonomous turn with no further interaction — you cannot ask the dispatcher follow-up questions, and a subagent cannot dispatch its own subagents. If the task is ambiguous, state the assumption you made and proceed with the most reasonable interpretation rather than stopping.

Your final message is the ONLY thing returned to the dispatcher; your intermediate steps are not visible to it. Make the final message a complete, self-contained report: what you did, what you found (with concrete file paths, identifiers, and line numbers where relevant), and any caveats or remaining unknowns.`

/**
 * The built-in general-purpose subagent. A factory (not a frozen const) so each
 * caller gets an independent object — callers may carry it into per-turn context
 * maps and we never want shared mutable identity across sessions.
 */
export function generalPurposeAgent(): AgentSummary {
  return {
    id: GENERAL_PURPOSE_AGENT_ID,
    name: GENERAL_PURPOSE_AGENT_ID,
    description: GENERAL_PURPOSE_DESCRIPTION,
    def: {
      id: GENERAL_PURPOSE_AGENT_ID,
      name: GENERAL_PURPOSE_AGENT_ID,
      description: GENERAL_PURPOSE_DESCRIPTION,
      prompt: GENERAL_PURPOSE_PROMPT,
      // No `model` → inherits the active provider's model in buildChildConfig.
      // No `tools` → inherits the parent's full toolset.
    },
  }
}

/** All CLI built-in subagent ids (membership checks / introspection). */
export const BUILTIN_AGENT_IDS: ReadonlyArray<string> = [GENERAL_PURPOSE_AGENT_ID]

/** Factories for every CLI built-in subagent — called fresh so each union gets
 * an independent object (callers carry these into per-turn context maps). */
const BUILTIN_AGENT_FACTORIES: ReadonlyArray<() => AgentSummary> = [generalPurposeAgent]

/**
 * Union the discovered (`.cognia/agents/*.md`) subagents with the built-ins,
 * keeping discovered agents first. A user-authored agent whose id collides with
 * a built-in WINS — so `general-purpose.md` on disk customizes the built-in
 * rather than duplicating it. Pure: the input array is never mutated.
 */
export function withBuiltinAgents(discovered: AgentSummary[]): AgentSummary[] {
  const ids = new Set(discovered.map((a) => a.id))
  const builtins = BUILTIN_AGENT_FACTORIES.map((make) => make()).filter((a) => !ids.has(a.id))
  return [...discovered, ...builtins]
}
