/**
 * The agents Cognia ships, written once and read by every shell (ADR-0161).
 *
 * The prompts below are the merged text. `Explore` and `Plan` previously
 * existed twice, in `lib/claude/agents/subagents/` and in
 * `cli/src/agent/builtin-agents.ts`, with different wording and different
 * descriptions, so the same name meant two different agents depending on which
 * shell dispatched it. Each merged prompt keeps the concrete working guidance
 * the app's version carried and the leaf and no-follow-up constraints the CLI's
 * version stated.
 */

import { readOnlyBuiltinToolNames } from "@/lib/settings/builtin-tools"
import type { AgentDefinition } from "@/lib/claude/agents/subagents/types"
import { workflowDesignerAgent } from "@/lib/claude/agents/subagents/workflow-designer"
import { workflowDebuggerAgent } from "@/lib/claude/agents/subagents/workflow-debugger"
import { workflowRefactorerAgent } from "@/lib/claude/agents/subagents/workflow-refactorer"
import { workflowDocWriterAgent } from "@/lib/claude/agents/subagents/workflow-doc-writer"
import type { BuiltinAgentEntry, BuiltinAgentSurface, BuiltinToolPolicy } from "./types"

/** Canonical id of the always-available general-purpose agent. */
export const GENERAL_PURPOSE_AGENT_ID = "general-purpose"
/** Canonical id of the read-only exploration agent. */
export const EXPLORE_AGENT_ID = "Explore"
/** Canonical id of the read-only planning agent. */
export const PLAN_AGENT_ID = "Plan"

const GENERAL_PURPOSE_PROMPT = `You are a general-purpose subagent dispatched to autonomously complete a delegated task.

You have access to the same tools as the agent that dispatched you (file search, reading, editing, shell, and more). Work the task end to end: search and read whatever you need, take the actions the task requires, and verify your work before you respond.

You run as a single autonomous turn with no further interaction. You cannot ask the dispatcher follow-up questions, and you cannot dispatch subagents of your own. If the task is ambiguous, state the assumption you made and proceed with the most reasonable interpretation rather than stopping.

Your final message is the ONLY thing returned to the dispatcher, and your intermediate steps are not visible to it. Make the final message a complete, self-contained report: what you did, what you found (with concrete file paths, identifiers, and line numbers where relevant), and any caveats or remaining unknowns.`

const EXPLORE_PROMPT = `You are the Explore subagent, a fast read-only code scout.

Your job: given a focused question or area, locate the relevant code and report back concisely. You read excerpts and search broadly. You do NOT review, audit, or edit, you cannot run mutating commands, and you cannot dispatch further subagents.

HOW TO WORK
1. Search widely first (grep / glob / content search / codegraph if available) to
   find candidate files, then read only the excerpts you need to confirm.
2. Prefer breadth: cover multiple naming conventions and locations before
   drilling in. Note where a thing is defined, who calls it, and how the pieces
   connect.
3. Ground every claim in a real path. Cite \`file:line\` for anything load-bearing,
   and do not paste large file bodies.
4. Be concise. Return a structured digest: the key files and symbols, how they
   relate, and any gaps or surprises. This digest is consumed by another agent,
   not shown to a human, so return data rather than prose.`

const PLAN_PROMPT = `You are the Plan subagent, a software architect that designs implementation plans.

Your job: given a task and (usually) a digest of exploration findings, produce a concrete, ordered implementation plan. You may read files to verify details, but you have no tools that could change anything, and you cannot dispatch further subagents.

HOW TO WORK
1. Confirm the critical files and current behavior with quick reads. Never invent
   paths or APIs.
2. If the dispatcher handed you exploration digests, build on them rather than
   re-deriving everything.
3. Prefer the smallest change that fully solves the task. Reuse existing
   utilities, components, and patterns, and call them out by \`file:line\`.
4. Return a step-by-step plan: for each step, name the file(s) to change and the
   verification that proves it works. Flag risks, edge cases, and trade-offs.
5. Be concise and concrete. Your output is consumed by another agent (or fed into
   the plan-approval flow), so return an actionable plan rather than an essay.`

/**
 * `Explore` and `Plan` are dispatch-and-CLI agents rather than session agents:
 * they are targetable by `dispatch_agent` in any chat, and offered by the CLI,
 * but they are not injected into any session's native agents map.
 *
 * `general-purpose` is offered on `team` and `cli` only. It is deliberately NOT
 * on `dispatch`, which is context-free: adding a general delegate to every chat
 * turn is a behaviour change that deserves its own decision, and the app already
 * surfaces six dispatchable agents, so `dispatch_agent` is never withheld there.
 */
/**
 * Wrap one of the workflow-editor agents.
 *
 * Their prompts stay in their own modules beside the workflow domain rather
 * than moving into this file. What this catalog owns is the LIST, so there is
 * one answer to "what ships", not the prose of every entry.
 */
function workflowEntry(id: string, name: string, def: AgentDefinition): BuiltinAgentEntry {
  return {
    id,
    name,
    description: def.description,
    prompt: def.prompt,
    surfaces: ["workflow-editor", "team", "dispatch"],
    toolPolicy: def.tools ? { kind: "allowlist", tools: def.tools } : { kind: "inherit" },
    ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
  }
}

const ENTRIES: readonly BuiltinAgentEntry[] = [
  {
    id: GENERAL_PURPOSE_AGENT_ID,
    name: "General Purpose",
    description:
      "General-purpose agent for researching complex questions, searching across the codebase, and executing multi-step tasks autonomously. Use when a task is open-ended or needs several rounds of searching, reading, and editing, and you are not confident the first attempt will land it.",
    prompt: GENERAL_PURPOSE_PROMPT,
    surfaces: ["team", "cli"],
    toolPolicy: { kind: "inherit" },
  },
  {
    id: EXPLORE_AGENT_ID,
    name: "Explore",
    description:
      "Read-only search scout for broad codebase exploration. It locates where code lives and how it connects across many files and naming conventions, and reports a digest with `file:line` citations. Dispatch it (in parallel for independent areas) during plan-mode research before proposing changes. It reads and searches only, and never edits or reviews.",
    prompt: EXPLORE_PROMPT,
    surfaces: ["dispatch", "cli"],
    toolPolicy: { kind: "read-only" },
    maxTurns: 20,
  },
  {
    id: PLAN_AGENT_ID,
    name: "Plan",
    description:
      "Read-only architect that turns a task (plus exploration findings) into a concrete, step-by-step implementation plan grounded in real files. It names the critical files, reuses existing patterns, and lists the verification for each step. Dispatch it during plan-mode research after exploring. It proposes only, and never edits.",
    prompt: PLAN_PROMPT,
    surfaces: ["dispatch", "cli"],
    toolPolicy: { kind: "read-only" },
    maxTurns: 20,
  },
  workflowEntry("workflow-designer", "Workflow Designer", workflowDesignerAgent),
  workflowEntry("workflow-debugger", "Workflow Debugger", workflowDebuggerAgent),
  workflowEntry("workflow-refactorer", "Workflow Refactorer", workflowRefactorerAgent),
  workflowEntry("workflow-doc-writer", "Workflow Doc Writer", workflowDocWriterAgent),
]

/** Every built-in, in catalog order. */
export function builtinAgents(): readonly BuiltinAgentEntry[] {
  return ENTRIES
}

/** The built-ins offered on one surface, in catalog order. */
export function builtinAgentsForSurface(
  surface: BuiltinAgentSurface
): readonly BuiltinAgentEntry[] {
  return ENTRIES.filter((entry) => entry.surfaces.includes(surface))
}

/** One built-in by its dispatcher id. */
export function builtinAgentById(id: string): BuiltinAgentEntry | undefined {
  return ENTRIES.find((entry) => entry.id === id)
}

/** Every built-in id, for membership checks and introspection. */
export const BUILTIN_AGENT_IDS: readonly string[] = ENTRIES.map((entry) => entry.id)

/**
 * Resolve a tool policy into an allowlist, or `undefined` to inherit.
 *
 * Called at projection time rather than at module load, so a change to the
 * built-in tool catalogue is picked up without a restart, which is what the
 * app's original `readOnlyBuiltinToolNames()` call did.
 */
export function resolveBuiltinToolPolicy(policy: BuiltinToolPolicy): string[] | undefined {
  switch (policy.kind) {
    case "inherit":
      return undefined
    case "read-only":
      return readOnlyBuiltinToolNames()
    case "allowlist":
      return [...policy.tools]
  }
}

/**
 * Project one entry into the SDK `AgentDefinition` shape that rides
 * `SendOptions.agents` and the renderer's own dispatch path.
 */
export function builtinAgentDefinition(entry: BuiltinAgentEntry): AgentDefinition {
  const tools = resolveBuiltinToolPolicy(entry.toolPolicy)
  return {
    description: entry.description,
    prompt: entry.prompt,
    ...(tools ? { tools } : {}),
    ...(entry.maxTurns !== undefined ? { maxTurns: entry.maxTurns } : {}),
  }
}
