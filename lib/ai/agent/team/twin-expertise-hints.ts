/**
 * Twin-expertise assignee hints for the task board (twin visibility pass).
 *
 * Ranks a team's roster for a given task by naive token overlap between the
 * task's tags/title and each teammate's bound-twin expertise blurb (the
 * content-free `TeamTwinSummary.expertise` produced by `gatherTeamTwins` in
 * `twin-context.ts`). Pure + deterministic — ZERO LLM calls and zero new
 * data flows; this only surfaces bindings the runtime already uses.
 */

import type { AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import type { TeamTwinSummary } from "./team-run-context"

export interface AssigneeHint {
  teammateId: string
  teammateName: string
  /** The teammate's bound digital employee, when any. */
  twinId?: string
  twinName?: string
  /** Content-free expertise blurb (voice summary + key entities). */
  expertise?: string
  /** Overlap score between the task's tokens and the expertise blurb. */
  score: number
}

/** Lowercased word tokens, ≥3 chars (drops "a"/"of"-class noise). */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 64)
}

/** Count how many distinct task tokens appear in the expertise blurb. */
export function expertiseMatchScore(taskTokens: readonly string[], expertise: string): number {
  if (taskTokens.length === 0 || expertise.length === 0) return 0
  const haystack = expertise.toLowerCase()
  let score = 0
  for (const token of new Set(taskTokens)) {
    if (haystack.includes(token)) score += 1
  }
  return score
}

/**
 * Rank the roster for an assignee picker: strongest expertise match first,
 * then remaining twin-bound teammates, then the rest — stable within each
 * band (roster order). Leads are callers' choice to include.
 */
export function rankAssigneesForTask(
  task: Pick<AgentTeamTask, "title" | "tags"> & { description?: string },
  teammates: readonly AgentTeammate[],
  twins: readonly TeamTwinSummary[]
): AssigneeHint[] {
  const twinsById = new Map(twins.map((t) => [t.id, t]))
  const taskTokens = [
    ...task.tags.flatMap((tag) => tokenize(tag)),
    ...tokenize(task.title),
    ...tokenize(task.description ?? ""),
  ]

  const hints = teammates.map((mate, index) => {
    const twin = mate.config?.twinId ? twinsById.get(mate.config.twinId) : undefined
    const expertise = twin?.expertise ?? ""
    return {
      hint: {
        teammateId: mate.id,
        teammateName: mate.name,
        ...(mate.config?.twinId ? { twinId: mate.config.twinId } : {}),
        ...(twin?.name ? { twinName: twin.name } : {}),
        ...(expertise ? { expertise } : {}),
        score: expertiseMatchScore(taskTokens, expertise),
      } satisfies AssigneeHint,
      index,
    }
  })

  return hints
    .sort((a, b) => {
      if (a.hint.score !== b.hint.score) return b.hint.score - a.hint.score
      const aBound = a.hint.twinId ? 1 : 0
      const bBound = b.hint.twinId ? 1 : 0
      if (aBound !== bBound) return bBound - aBound
      return a.index - b.index
    })
    .map((h) => h.hint)
}
