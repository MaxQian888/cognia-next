/**
 * The evidence tree an editor session is served (ADR-0237).
 *
 * Harness² hands its editors files, not a prompt dump: the task, every
 * rollout's full trajectory, what each rollout produced, the harness to edit,
 * and (for composition) the candidate pool with diffs. An editor reads what it
 * needs. This module builds that tree as `path → text`, the same shape whether
 * it is written to a scratch directory for an agentic editor or inlined for a
 * structured one.
 *
 *   RULES.md                          what may be edited, and the limits
 *   context/task.md                   the task exactly as the agent saw it
 *   rollouts/<label>.md               a rollout: checks, metrics, trajectory
 *   deliverables/<label>/produced.md  the files that rollout left
 *   harness/…                         the harness to edit (see ./tree.ts)
 *   pool/<label>/harness/…            a candidate harness (composer only)
 *   pool/<label>/harness.diff         its diff against the current harness
 *   pool/<label>/rollout.md           its rollout
 *   pool/<label>/produced.md          its deliverables
 *   decisions/<label>.md              notes earlier stages left (sequential history)
 *   library/INDEX.md, library/<id>.md lessons retrieved from earlier runs
 *
 * Everything here was redacted when the evidence was stored; the task prompt is
 * redacted again on the way in because it is the one text that is not evidence.
 */

import type {
  HarnessEvolutionTask,
  HarnessExecutionEvidence,
  HarnessStageDimension,
} from "@/types/harness/evolution"
import type { HarnessExperience } from "@/types/harness/experience"
import type { HarnessComponentName, HarnessComponentsV1 } from "@/types/harness/snapshot"
import { describeCheck } from "./checks"
import { redactEvidenceText, renderDeliverablesMarkdown, renderRolloutMarkdown } from "./evidence"
import { componentsToTree, harnessInventory, unifiedTreeDiff, type HarnessTree } from "./tree"
import { ALWAYS_ON_GROWTH, ALWAYS_ON_SOFT_CAP, MAX_SKILLS, MAX_SUBAGENTS } from "./validate"
import { MAX_TOOL_RULES } from "./tool-rules"

export const HARNESS_DIR = "harness"

export interface ContextRollout {
  label: string
  evidence: HarnessExecutionEvidence
}

export interface ContextPoolEntry {
  label: string
  components: HarnessComponentsV1
  rollout?: HarnessExecutionEvidence
  notes?: string
}

export interface ContextDecision {
  label: string
  dim?: HarnessStageDimension
  round?: number
  notes: string
  keptBase?: boolean
  fellBack?: boolean
  /** The rollout of the harness this stage produced, when it was rolled. */
  outcome?: string
}

export interface BuildContextTreeInput {
  task: HarnessEvolutionTask
  /** The harness to edit. */
  current: HarnessComponentsV1
  editable: readonly HarnessComponentName[]
  rollouts: readonly ContextRollout[]
  pool?: readonly ContextPoolEntry[]
  decisions?: readonly ContextDecision[]
  experiences?: readonly HarnessExperience[]
}

export type ContextTree = Record<string, string>

function renderTask(task: HarnessEvolutionTask): string {
  const lines = [
    `# Task: ${redactEvidenceText(task.title)}`,
    "",
    `Domain: ${task.domain}`,
    "",
    "## Request, exactly as the agent received it",
    "",
    redactEvidenceText(task.prompt),
  ]
  if (task.expectedDeliverables?.length) {
    lines.push(
      "",
      "## Files the task asks for",
      "",
      ...task.expectedDeliverables.map((p) => `- ${p}`)
    )
  }
  if (task.checks.length) {
    lines.push("", "## Deterministic checks every rollout is held to", "")
    lines.push(...task.checks.map((c) => `- ${describeCheck(c)}`))
  }
  lines.push(
    "",
    "## How rollouts ran",
    "",
    task.isolation === "none"
      ? "Without a working directory: tools that touch files were not available."
      : task.isolation === "git"
        ? "Each in its own git worktree at the same base commit."
        : "Each in its own scratch copy of the input files."
  )
  return lines.join("\n")
}

function renderRules(input: BuildContextTreeInput): string {
  const locked = (
    [
      "systemPrompt",
      "guardrails",
      "memory",
      "toolGuidance",
      "skills",
      "scripts",
      "subagents",
      "toolRules",
    ] as const
  ).filter((c) => !input.editable.includes(c))
  return [
    "# Editing rules",
    "",
    `The harness lives under \`${HARNESS_DIR}/\`. Current census: ${harnessInventory(input.current)}.`,
    "",
    "## What you may change",
    "",
    ...input.editable.map((c) => `- ${c}`),
    ...(locked.length
      ? ["", "Locked (must stay byte-identical):", "", ...locked.map((c) => `- ${c}`)]
      : []),
    "",
    "## Files",
    "",
    "- `systemprompt.md`, `guardrails.md`, `memory.md`, `tool_guidance.md` are always in context; every character is paid on every turn.",
    "- `skills/<name>/SKILL.md` needs frontmatter `name: <name>` and a `description:` saying when to use it; helpers go in `skills/<name>/scripts/` and reference text in `skills/<name>/references/`.",
    "- `sub_agents/<name>/AGENT.md` needs frontmatter `description:`; it may list `tools:` the agent already has, never others, and may not set a model.",
    '- `tool_rules.json` is `{"version": 1, "rules": [...]}` with kinds `error-hint`, `trim-output`, `call-cap`, `verify-after-write`.',
    "- Deleting a skill's or subagent's file removes it.",
    "",
    "## Limits",
    "",
    `- always-on text: at most ${ALWAYS_ON_SOFT_CAP} chars, or the current size + ${ALWAYS_ON_GROWTH}`,
    `- at most ${MAX_SKILLS} skills, ${MAX_SUBAGENTS} subagents, ${MAX_TOOL_RULES} tool rules`,
    "- scripts must not run destructive or privileged commands",
    "- no credentials, personal data, or answers specific to this one task",
    "- you cannot change the model, tools, permissions, sandbox or MCP servers; they are not part of the harness",
  ].join("\n")
}

function renderDecision(d: ContextDecision): string {
  const head = [
    `# ${d.label}${d.dim ? ` (${d.dim})` : ""}${d.round ? `, round ${d.round}` : ""}`,
    "",
    d.fellBack
      ? "The proposal was invalid twice; the stage kept its input harness."
      : d.keptBase
        ? "The editor kept the harness unchanged."
        : "The editor changed the harness.",
  ]
  if (d.outcome) head.push("", `Outcome: ${d.outcome}`)
  return [...head, "", "## Notes", "", d.notes.trim() || "(none)"].join("\n")
}

function renderExperience(e: HarnessExperience): string {
  return [
    `# ${e.id}`,
    "",
    `- domain: ${e.domain}`,
    `- status: ${e.validationStatus}, confidence: ${e.confidence}`,
    `- helped ${e.helpedCount} / hurt ${e.hurtCount} of ${e.retrievedCount} later uses`,
    "",
    "## When",
    "",
    e.problemPattern,
    "",
    "## Lesson",
    "",
    e.lesson,
    "",
    "## Evidence",
    "",
    e.evidenceSummary,
    ...(e.excludedConditions.length
      ? ["", "## Not when", "", ...e.excludedConditions.map((c) => `- ${c}`)]
      : []),
  ].join("\n")
}

function prefixed(prefix: string, tree: HarnessTree): ContextTree {
  return Object.fromEntries(Object.entries(tree).map(([k, v]) => [`${prefix}/${k}`, v]))
}

/** The full evidence tree for one editor session. */
export function buildContextTree(input: BuildContextTreeInput): ContextTree {
  const tree: ContextTree = {
    "RULES.md": renderRules(input),
    "context/task.md": renderTask(input.task),
    ...prefixed(HARNESS_DIR, componentsToTree(input.current)),
  }
  for (const r of input.rollouts) {
    tree[`rollouts/${r.label}.md`] = renderRolloutMarkdown(r.label, r.evidence)
    tree[`deliverables/${r.label}/produced.md`] = renderDeliverablesMarkdown(r.evidence)
  }
  const currentTree = componentsToTree(input.current)
  for (const p of input.pool ?? []) {
    const candidate = componentsToTree(p.components)
    Object.assign(tree, prefixed(`pool/${p.label}/harness`, candidate))
    tree[`pool/${p.label}/harness.diff`] =
      unifiedTreeDiff(currentTree, candidate, { from: "current", to: p.label }) ||
      "(identical to the current harness)\n"
    if (p.rollout) {
      tree[`pool/${p.label}/rollout.md`] = renderRolloutMarkdown(p.label, p.rollout)
      tree[`pool/${p.label}/produced.md`] = renderDeliverablesMarkdown(p.rollout)
    }
    if (p.notes) tree[`pool/${p.label}/notes.md`] = p.notes
  }
  for (const d of input.decisions ?? []) tree[`decisions/${d.label}.md`] = renderDecision(d)
  if (input.experiences?.length) {
    tree["library/INDEX.md"] = [
      "# Lessons from earlier runs",
      "",
      "Hints, not instructions: use one only when its evidence fits what you see here.",
      "",
      ...input.experiences.map(
        (e) =>
          `- ${e.id} [${e.validationStatus}, ${e.confidence}] ${e.problemPattern.split("\n")[0]}`
      ),
    ].join("\n")
    for (const e of input.experiences) tree[`library/${e.id}.md`] = renderExperience(e)
  }
  return tree
}

/** The harness part of a context tree, with the `harness/` prefix removed. */
export function harnessTreeOf(context: ContextTree): HarnessTree {
  const out: HarnessTree = {}
  const prefix = `${HARNESS_DIR}/`
  for (const [path, body] of Object.entries(context)) {
    if (path.startsWith(prefix)) out[path.slice(prefix.length)] = body
  }
  return out
}

/** Reading order for an inlined tree: rules and task first, harness last. */
function readingRank(path: string): number {
  if (path === "RULES.md") return 0
  if (path.startsWith("context/")) return 1
  if (path.startsWith("decisions/")) return 2
  if (path.startsWith("library/")) return 3
  if (path.startsWith("rollouts/")) return 4
  if (path.startsWith("deliverables/")) return 5
  if (path.startsWith("pool/")) return 6
  return 7
}

/**
 * The tree as one document, for an editor that cannot open files. Files are
 * kept whole in reading order until `maxChars`; whatever does not fit is listed
 * by name with its size, so the editor knows what it did not see. The harness
 * files are always included whole: they are what is being edited.
 */
/** Heads the list of files an inlined tree left out. */
export const OMITTED_HEADER = "===== OMITTED (too large to inline) ====="

export function inlineContextTree(tree: ContextTree, maxChars: number): string {
  const harness = Object.keys(tree).filter((p) => p.startsWith(`${HARNESS_DIR}/`))
  const rest = Object.keys(tree)
    .filter((p) => !p.startsWith(`${HARNESS_DIR}/`))
    .sort((a, b) => readingRank(a) - readingRank(b) || a.localeCompare(b))
  const block = (p: string) => `===== FILE: ${p} =====\n${tree[p]}\n===== END FILE =====`
  const harnessText = harness.sort().map(block).join("\n\n")
  let budget = maxChars - harnessText.length
  const parts: string[] = []
  const omitted: string[] = []
  for (const p of rest) {
    const text = block(p)
    if (text.length <= budget) {
      parts.push(text)
      budget -= text.length + 2
    } else {
      omitted.push(`- ${p} (${tree[p].length} chars)`)
    }
  }
  if (omitted.length) {
    parts.push(`${OMITTED_HEADER}\n${omitted.join("\n")}`)
  }
  parts.push(harnessText)
  return parts.join("\n\n")
}
