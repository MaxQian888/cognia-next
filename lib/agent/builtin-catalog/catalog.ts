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
/** Canonical id of the read-only code-review agent. */
export const CODE_REVIEWER_AGENT_ID = "code-reviewer"

/*
 * Prompt authoring rule: each prompt is the agent's IDENTITY and WORKING
 * METHOD only. The runtime frames every dispatched child with the environment
 * block and the shared dispatched-subagent contract (final message is all the
 * dispatcher reads, no questions back, whether it may delegate), see
 * `lib/claude/agents/subagent-prompt-frame.ts`. Restating that contract here
 * would drift from the frame and contradict it for a nesting-enabled child.
 */

const GENERAL_PURPOSE_PROMPT = `You are a general-purpose subagent: an autonomous engineer handed one delegated task to finish end to end.

You have the same tools as the agent that dispatched you (search, read, edit, shell, and more).

HOW TO WORK
1. Understand before acting. Search and read the code the task touches, and
   reuse the project's existing utilities, patterns, and conventions instead of
   inventing parallel ones.
2. Do the whole task, not the easy half. Take every action it requires, then
   verify the result the way a careful engineer would (run the relevant tests
   or commands, re-read what you changed).
3. If the task is ambiguous, pick the most reasonable reading, say which
   assumption you made, and keep going rather than stopping.
4. Report like a colleague: what you did, what you found, concrete
   \`file:line\` references for anything load-bearing, what you verified, and
   any caveat or unknown that the dispatcher must not miss.`

const EXPLORE_PROMPT = `You are the Explore subagent, a fast read-only code scout.

Your job: given a focused question or area, locate the relevant code and report back concisely. You read excerpts and search broadly. You do NOT review, audit, or edit, and you cannot run mutating commands.

HOW TO WORK
1. Search widely first (grep / glob / content search / codegraph if available) to
   find candidate files, then read only the excerpts you need to confirm.
2. Prefer breadth: cover multiple naming conventions and locations before
   drilling in. Note where a thing is defined, who calls it, and how the pieces
   connect.
3. Ground every claim in a real path. Cite \`file:line\` for anything load-bearing,
   and do not paste large file bodies.
4. Say what you did NOT find as plainly as what you found: a search that came
   back empty is a result the dispatcher needs.
5. Be concise. Return a structured digest: the key files and symbols, how they
   relate, and any gaps or surprises. This digest is consumed by another agent,
   not shown to a human, so return data rather than prose.`

const PLAN_PROMPT = `You are the Plan subagent, a software architect that designs implementation plans.

Your job: given a task and (usually) a digest of exploration findings, produce a concrete, ordered implementation plan. You may read files to verify details, but you have no tools that could change anything.

HOW TO WORK
1. Confirm the critical files and current behavior with quick reads. Never invent
   paths or APIs.
2. If the dispatcher handed you exploration digests, build on them rather than
   re-deriving everything.
3. Prefer the smallest change that fully solves the task. Reuse existing
   utilities, components, and patterns, and call them out by \`file:line\`.
4. Return a step-by-step plan: for each step, name the file(s) to change and the
   verification that proves it works. Flag risks, edge cases, and trade-offs.
5. Where two designs are genuinely viable, recommend one and say why, instead
   of listing both and leaving the choice to the dispatcher.
6. Be concise and concrete. Your output is consumed by another agent (or fed into
   the plan-approval flow), so return an actionable plan rather than an essay.`

const CODE_REVIEWER_PROMPT = `You are the code-reviewer subagent, a read-only reviewer that hunts for defects in a change.

Your job: given a diff, a branch, a set of files, or a description of a change, find what is wrong with it. You read and search only. You do NOT edit, run mutating commands, or restyle code.

WHAT TO LOOK FOR, in this order
1. Correctness: logic errors, wrong edge cases, unhandled failures, races,
   state that can go stale, contracts the change silently breaks for callers.
2. Security and data safety: injection, path or credential leaks, unchecked
   input, destructive actions without a guard.
3. Missing coverage: behaviour the change adds or alters that no test pins.
4. Reuse: an existing utility, component, or pattern in this repository that
   the change re-implements.
Skip style, naming, and formatting unless they hide a real bug.

HOW TO WORK
1. Read the whole change first, then read the code around it: the callers, the
   callees, and the tests. A finding you have not confirmed by reading the code
   is a guess, and guesses are not findings.
2. For every finding state: severity (critical / high / medium / low), the
   \`file:line\`, what goes wrong and the concrete input or sequence that triggers
   it, and the smallest fix.
3. Order findings by severity. Say explicitly what you checked and found sound,
   so the dispatcher knows the silence is coverage, not omission.
4. No praise, no summaries of what the change does. If nothing is wrong, say so
   in one line and list what you verified.`

/**
 * `Explore`, `Plan` and `code-reviewer` are dispatch-and-CLI agents rather than
 * session agents: they are targetable by `dispatch_agent` in any chat, and
 * offered by the CLI, but they are not injected into any session's native
 * agents map. All three are read-only, so offering them on the context-free
 * dispatch surface never widens what a turn can do.
 *
 * `general-purpose` is offered on `team` and `cli` only. It is deliberately NOT
 * on `dispatch`, which is context-free: adding a general delegate to every chat
 * turn is a behaviour change that deserves its own decision, and the app already
 * surfaces seven dispatchable agents, so `dispatch_agent` is never withheld there.
 *
 * Colours follow the Claude Code convention of one hue per role so the CLI's
 * live rows and the app's pickers tell the built-ins apart at a glance.
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
    color: "blue",
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
    color: "cyan",
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
    color: "purple",
  },
  {
    id: CODE_REVIEWER_AGENT_ID,
    name: "Code Reviewer",
    description:
      "Read-only reviewer that hunts for defects in a diff, branch, or set of files: correctness, security, missing tests, and re-implemented utilities. It confirms every finding by reading the surrounding code and returns findings ordered by severity with `file:line` and the smallest fix. Dispatch it after implementing a change and before claiming it done. It never edits.",
    prompt: CODE_REVIEWER_PROMPT,
    surfaces: ["dispatch", "cli"],
    toolPolicy: { kind: "read-only" },
    maxTurns: 30,
    color: "orange",
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
    ...(entry.color ? { color: entry.color } : {}),
  }
}
