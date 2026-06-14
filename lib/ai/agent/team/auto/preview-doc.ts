/**
 * Render an `AutoOrchestrationProposal` as a markdown document.
 *
 * Pure and surface-agnostic: the CLI `/team auto` pager and the desktop preview
 * sheet both render the same proposal text so the operator reviews an identical
 * roster + task DAG before approving. No i18n here — it is developer/preview
 * scaffolding shown in a monospace pager, and the CLI has no next-intl context.
 */

import type { TeamExecutionPattern } from "@/types/agent/agent-team"
import type { AutoOrchestrationProposal } from "./types"

const PATTERN_LABELS: Record<TeamExecutionPattern, string> = {
  manager_worker: "Manager / worker",
  parallel_specialists: "Parallel specialists",
  background_handoff: "Background handoff",
  external_handoff: "External handoff",
  single_agent_recommended: "Single agent (recommended)",
  ultracode_orchestration: "Ultracode orchestration",
}

/** Flatten a teammate capability overlay's `add` ids into a compact string. */
function overlaySummary(proposal: AutoOrchestrationProposal, index: number): string {
  const caps = proposal.roster[index].capabilities
  if (!caps) return ""
  const ids = Object.values(caps)
    .flatMap((o) => o?.add ?? [])
    .filter(Boolean)
  return ids.length ? ` · caps: ${ids.join(", ")}` : ""
}

export function renderProposalDoc(proposal: AutoOrchestrationProposal): string {
  const { assessment, roster, tasks } = proposal
  const lines: string[] = []

  lines.push("# Auto-composed team", "")
  lines.push(`**Objective:** ${proposal.objective}`, "")

  // Routing assessment.
  lines.push("## Routing assessment", "")
  lines.push(
    `- Pattern: **${PATTERN_LABELS[assessment.recommendedPattern]}** (confidence ${Math.round(
      assessment.confidence * 100
    )}%)`
  )
  lines.push(`- Complexity: ${assessment.factors.taskComplexity}`)
  lines.push(
    `- Specialization needed: ${assessment.factors.specializationNeeded ? "yes" : "no"} · Budget pressure: ${assessment.factors.budgetPressure}`
  )
  lines.push(`- Reason: ${assessment.reason}`, "")

  // Roster.
  lines.push(`## Roster (${roster.length})`, "")
  roster.forEach((m, i) => {
    const lead = m.role === "lead" ? " 👑" : ""
    const spec = m.specialization ? ` _(${m.specialization})_` : ""
    lines.push(`${i}. **${m.name}**${lead}${spec} — ${m.description}${overlaySummary(proposal, i)}`)
  })
  lines.push("")

  // Task DAG.
  lines.push(`## Tasks (${tasks.length})`, "")
  tasks.forEach((t, i) => {
    const assignee = roster[t.assignedTo]?.name ?? `#${t.assignedTo}`
    const deps = t.dependencies.length
      ? ` · after ${t.dependencies.map((d) => `#${d}`).join(", ")}`
      : ""
    lines.push(`${i}. **${t.title}** → ${assignee}${deps}`)
    lines.push(`   ${t.description}`)
    if (t.expectedOutput) lines.push(`   _Expected:_ ${t.expectedOutput}`)
  })

  return lines.join("\n")
}
