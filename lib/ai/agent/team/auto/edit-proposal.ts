/**
 * Pure, index-safe edit operations for an `AutoOrchestrationProposal` preview.
 *
 * The proposal uses **index-based** references (`task.assignedTo` → roster
 * index, `task.dependencies` → earlier task indices). When the operator edits
 * the roster or task list in the preview, those indices must be kept
 * consistent or `materializeProposal` would dereference a stale slot. Every
 * structural mutation lives here as a pure function so the dialog stays thin
 * and the remapping is unit-tested in isolation.
 *
 * Field-only edits (rename, description, specialization, capabilities, task
 * title/description, assignee, dependencies) don't move indices and are applied
 * inline by the editors; only add / remove / set-lead reshape the arrays.
 */

import type { ProposedTask, ProposedTeammate } from "./types"

/** Append a blank teammate (role "teammate"). The lead always stays index 0. */
export function addMember(roster: ProposedTeammate[]): ProposedTeammate[] {
  return [...roster, { name: "", role: "teammate", description: "" }]
}

/**
 * Remove roster member `index`, remapping every task's `assignedTo`:
 * tasks pointing at the removed member fall back to the lead (0); tasks
 * pointing at a later member shift down by one. Roles are renormalized so
 * index 0 is the sole lead. A roster of ≤1 member is returned unchanged.
 */
export function removeMember(
  roster: ProposedTeammate[],
  tasks: ProposedTask[],
  index: number
): { roster: ProposedTeammate[]; tasks: ProposedTask[] } {
  if (index < 0 || index >= roster.length || roster.length <= 1) return { roster, tasks }
  const nextRoster = roster
    .filter((_, i) => i !== index)
    .map((m, i) => ({ ...m, role: i === 0 ? ("lead" as const) : ("teammate" as const) }))
  const nextTasks = tasks.map((t) => ({
    ...t,
    assignedTo: t.assignedTo === index ? 0 : t.assignedTo > index ? t.assignedTo - 1 : t.assignedTo,
  }))
  return { roster: nextRoster, tasks: nextTasks }
}

/**
 * Promote member `index` to lead (moves it to position 0), remapping every
 * task's `assignedTo` through the old→new index map and renormalizing roles.
 */
export function setLead(
  roster: ProposedTeammate[],
  tasks: ProposedTask[],
  index: number
): { roster: ProposedTeammate[]; tasks: ProposedTask[] } {
  if (index <= 0 || index >= roster.length) return { roster, tasks }
  const map = new Array<number>(roster.length)
  map[index] = 0
  let pos = 1
  roster.forEach((_, i) => {
    if (i !== index) map[i] = pos++
  })
  const nextRoster = new Array<ProposedTeammate>(roster.length)
  roster.forEach((m, i) => {
    nextRoster[map[i]] = { ...m, role: map[i] === 0 ? "lead" : "teammate" }
  })
  const nextTasks = tasks.map((t) => ({
    ...t,
    assignedTo: map[t.assignedTo] ?? t.assignedTo,
  }))
  return { roster: nextRoster, tasks: nextTasks }
}

/** Append a blank task assigned to the lead with no dependencies. */
export function addTask(tasks: ProposedTask[]): ProposedTask[] {
  return [...tasks, { title: "", description: "", assignedTo: 0, dependencies: [] }]
}

/**
 * Remove task `index`, remapping the remaining tasks' `dependencies`: a dep on
 * the removed task is dropped, deps on later tasks shift down by one. Preserves
 * the "dependency index < own index" invariant.
 */
export function removeTask(tasks: ProposedTask[], index: number): ProposedTask[] {
  if (index < 0 || index >= tasks.length) return tasks
  return tasks
    .filter((_, i) => i !== index)
    .map((t) => ({
      ...t,
      dependencies: t.dependencies.filter((d) => d !== index).map((d) => (d > index ? d - 1 : d)),
    }))
}
