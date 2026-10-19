/**
 * Risk of adopting a harness change, and who must approve it (ADR-0237).
 *
 * The class is read from the diff against the base, never from the editor's
 * description of it:
 *
 * - high:   anything that executes or delegates — a script added or changed, a
 *           subagent added or changed, a tool-rule removed (a removed cap or
 *           hint loosens what the base enforced), or a skill whose allowed
 *           tools grew;
 * - medium: anything that changes how the agent works — the system prompt, a
 *           skill's instructions, a guardrail removed, a tool rule added;
 * - low:    additive always-on knowledge — memory, tool guidance and guardrail
 *           additions within a small growth.
 *
 * Global scope always needs a person; workspace scope too (it changes the
 * default for every conversation there). Task and session scope may skip
 * approval only for a low-risk change when the user turned auto-adoption on.
 */

import type { HarnessRiskClass } from "@/types/harness/evolution"
import type {
  HarnessComponentsV1,
  HarnessScope,
  HarnessSnapshotDiff,
} from "@/types/harness/snapshot"

/** Always-on growth a low-risk change may add. */
export const LOW_RISK_ALWAYS_ON_GROWTH = 1_500

export interface HarnessRiskAssessment {
  risk: HarnessRiskClass
  reasons: string[]
}

function lines(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
  )
}

/** Lines of `before` that `after` no longer has. */
function removedLines(before: string, after: string): string[] {
  const kept = lines(after)
  return [...lines(before)].filter((l) => !kept.has(l))
}

export function assessHarnessRisk(
  base: HarnessComponentsV1,
  candidate: HarnessComponentsV1,
  diff: HarnessSnapshotDiff
): HarnessRiskAssessment {
  const high: string[] = []
  const medium: string[] = []

  if (diff.executionChanged) high.push("the execution configuration changed")

  for (const change of diff.changes) {
    if (change.component === "scripts") high.push(`script ${change.path} ${change.change}`)
    if (change.component === "subagents") high.push(`subagent ${change.path} ${change.change}`)
  }

  const candidateRules = new Map(candidate.toolRules.map((r) => [r.id, r]))
  for (const rule of base.toolRules) {
    const now = candidateRules.get(rule.id)
    if (!now) high.push(`tool rule ${rule.id} removed`)
    else if (JSON.stringify(now) !== JSON.stringify(rule))
      medium.push(`tool rule ${rule.id} changed`)
  }
  const baseRuleIds = new Set(base.toolRules.map((r) => r.id))
  for (const rule of candidate.toolRules) {
    if (!baseRuleIds.has(rule.id)) medium.push(`tool rule ${rule.id} added`)
  }

  const baseSkills = new Map(base.skills.map((s) => [s.key, s]))
  for (const skill of candidate.skills) {
    const before = baseSkills.get(skill.key)
    if (!before) {
      medium.push(`skill ${skill.key} added`)
      if (skill.allowedTools?.length) high.push(`skill ${skill.key} pre-approves tools`)
      continue
    }
    const grown = (skill.allowedTools ?? []).filter((t) => !(before.allowedTools ?? []).includes(t))
    if (grown.length) high.push(`skill ${skill.key} pre-approves ${grown.join(", ")}`)
    if (before.content !== skill.content || before.description !== skill.description) {
      medium.push(`skill ${skill.key} changed`)
    }
  }
  const candidateSkillKeys = new Set(candidate.skills.map((s) => s.key))
  for (const skill of base.skills) {
    if (!candidateSkillKeys.has(skill.key)) medium.push(`skill ${skill.key} removed`)
  }

  if (base.systemPrompt !== candidate.systemPrompt) medium.push("the system prompt changed")
  const droppedGuardrails = removedLines(base.guardrails, candidate.guardrails)
  if (droppedGuardrails.length) medium.push(`${droppedGuardrails.length} guardrail lines removed`)
  const droppedMemory = removedLines(base.memory, candidate.memory)
  if (droppedMemory.length) medium.push(`${droppedMemory.length} memory lines removed`)
  if (diff.alwaysOnCharDelta > LOW_RISK_ALWAYS_ON_GROWTH) {
    medium.push(`always-on text grew by ${diff.alwaysOnCharDelta} chars`)
  }

  if (high.length) return { risk: "high", reasons: [...high, ...medium] }
  if (medium.length) return { risk: "medium", reasons: medium }
  const low = diff.changes.map((c) => `${c.path} ${c.change}`)
  return { risk: "low", reasons: low.length ? low : ["no change"] }
}

/** Whether adopting at `scope` needs a person's approval. */
export function requiresApproval(
  risk: HarnessRiskClass,
  scope: HarnessScope,
  autoAdoptLowRisk: boolean
): boolean {
  if (scope === "global" || scope === "workspace") return true
  return !(autoAdoptLowRisk && risk === "low")
}
