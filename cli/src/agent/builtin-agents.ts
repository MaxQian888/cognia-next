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
 * The built-ins here are:
 *   - `general-purpose` — inherits the active provider's model and the parent's
 *     full toolset (no `model` / `tools` override), so it can autonomously
 *     research and act on any delegated task.
 *   - `Explore` — a read-only search specialist (Claude Code parity), whitelisted
 *     to the read-only tool surface so it can locate/read code but never mutate.
 *   - `Plan` — a read-only software architect that designs an implementation plan.
 *
 * All run as leaves — the runner never re-surfaces `dispatch_agent` to a subagent
 * — so this does not introduce unbounded nesting. The read-only pair backs the
 * plan-mode explore→plan flow (system-prompt guidance + `/plan explore`).
 */

import { type AgentSummary } from "./discover-agents"
import { READ_ONLY_BUILTIN_TOOLS } from "./tool-suppression"

/** Canonical id of the always-available general-purpose subagent. */
export const GENERAL_PURPOSE_AGENT_ID = "general-purpose"

/** Canonical id of the built-in read-only exploration subagent. */
export const EXPLORE_AGENT_ID = "Explore"

/** Canonical id of the built-in read-only planning subagent. */
export const PLAN_AGENT_ID = "Plan"

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

const EXPLORE_DESCRIPTION =
  "Read-only search agent for broad fan-out searches — when answering means " +
  "sweeping many files, directories, or naming conventions and you only need the " +
  "conclusion, not the file dumps. It locates and reads code; it cannot edit, run " +
  "commands, or mutate the tree. Dispatch several in parallel to cover different " +
  "areas at once."

const EXPLORE_PROMPT = `You are a read-only exploration subagent dispatched to survey the codebase and report what you find.

Your job is to LOCATE and UNDERSTAND, not to change anything — you have only read/search tools (read, grep, glob, ls, codegraph, git status/log/diff). You cannot edit files, run mutating commands, or spawn further subagents.

Sweep broadly and efficiently: use grep/glob to find candidates, read the relevant excerpts, and follow the important call paths. Prefer breadth — cover every place the answer might live (multiple directories, naming conventions, both definition and call sites).

Your final message is the ONLY thing returned to the dispatcher. Make it a tight, self-contained digest: the concrete findings with \`path:line\` references, the key symbols/types involved, how the pieces connect, and any gaps you could not resolve. Do not paste large file bodies — cite locations.`

const PLAN_DESCRIPTION =
  "Read-only software-architect agent for designing an implementation plan. Give it " +
  "a task plus any exploration digests; it returns a concrete step-by-step plan, the " +
  "critical files to change, and the trade-offs it weighed. It designs only — it never edits."

const PLAN_PROMPT = `You are a read-only planning subagent — a software architect dispatched to design HOW a task should be implemented.

You have only read/search tools; you must not edit files or run mutating commands. Research whatever you still need to (read, grep, glob, codegraph), then produce the plan.

If the dispatcher handed you exploration digests, build on them rather than re-deriving everything. Ground the plan in the ACTUAL code: reuse existing utilities, functions, and patterns instead of inventing new ones, and name the specific files/symbols to touch.

Your final message IS the plan and the only thing returned. Return it as markdown: a short problem framing, then an ordered list of concrete implementation steps (each naming the file(s) and the change), the critical files to modify, the key trade-offs, and how to verify the result. Be specific enough to execute without re-planning.`

/** The built-in read-only exploration subagent (Claude Code's `Explore` parity).
 * Whitelisted to the read-only tool surface so it physically cannot mutate. */
export function exploreAgent(): AgentSummary {
  return {
    id: EXPLORE_AGENT_ID,
    name: EXPLORE_AGENT_ID,
    description: EXPLORE_DESCRIPTION,
    def: {
      id: EXPLORE_AGENT_ID,
      name: EXPLORE_AGENT_ID,
      description: EXPLORE_DESCRIPTION,
      prompt: EXPLORE_PROMPT,
      tools: [...READ_ONLY_BUILTIN_TOOLS],
    },
  }
}

/** The built-in read-only planning subagent (Claude Code's `Plan` parity).
 * Read-only like {@link exploreAgent}: it designs, it never edits. */
export function planAgent(): AgentSummary {
  return {
    id: PLAN_AGENT_ID,
    name: PLAN_AGENT_ID,
    description: PLAN_DESCRIPTION,
    def: {
      id: PLAN_AGENT_ID,
      name: PLAN_AGENT_ID,
      description: PLAN_DESCRIPTION,
      prompt: PLAN_PROMPT,
      tools: [...READ_ONLY_BUILTIN_TOOLS],
    },
  }
}

/** All CLI built-in subagent ids (membership checks / introspection). */
export const BUILTIN_AGENT_IDS: ReadonlyArray<string> = [
  GENERAL_PURPOSE_AGENT_ID,
  EXPLORE_AGENT_ID,
  PLAN_AGENT_ID,
]

/** Factories for every CLI built-in subagent — called fresh so each union gets
 * an independent object (callers carry these into per-turn context maps). */
const BUILTIN_AGENT_FACTORIES: ReadonlyArray<() => AgentSummary> = [
  generalPurposeAgent,
  exploreAgent,
  planAgent,
]

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
