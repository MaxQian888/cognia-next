/**
 * Durable storage for Squad DEFINITIONS: the squads themselves, their
 * teammates and their tasks.
 *
 * The runtime half has been in Dexie since v145 (`agentTeamRuns` plus ten
 * child tables, all workspace-scoped). The definition half was the one piece
 * still living in a `localStorage` blob, which meant `AgentTeam.projectId`
 * existed and was filtered on in three places while every workspace shared one
 * account-wide bucket. That is a filter, not a boundary, and it never crossed
 * to a phone.
 *
 * Named `agentTeam*` rather than `squad*` on purpose. ADR-0140 renamed the
 * product noun to Squad but deliberately left the type, store and runtime layer
 * as `AgentTeam*`, and `agentTeamRuns` is already here under that name. A
 * `teams` table also already exists and belongs to Character Teams, so taking
 * that name would have collided with a different feature entirely.
 *
 * Dates cross as epoch milliseconds. `AgentTeam.createdAt` is a `Date` in
 * memory, and IndexedDB can store one, but a row that round-trips through the
 * backup format and the sync transport comes back as a string. Normalising on
 * the way in and rebuilding on the way out means only this module has to know.
 */

import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import { getDb } from "./schema"

/**
 * Timestamps flattened to numbers. See the note on dates above.
 *
 * `updatedAt` has no counterpart in memory: the domain types never had one,
 * and sync needs a cursor. The mirror stamps it on every write, which is the
 * only place that knows a row actually changed.
 */
export type AgentTeamRow = Omit<AgentTeam, "createdAt" | "completedAt"> & {
  createdAt: number
  completedAt?: number
  updatedAt: number
}

export type AgentTeammateRow = Omit<AgentTeammate, "createdAt"> & {
  createdAt: number
  updatedAt: number
}

export type AgentTeamTaskRow = Omit<AgentTeamTask, "createdAt" | "completedAt" | "startedAt"> & {
  createdAt: number
  completedAt?: number
  startedAt?: number
  updatedAt: number
}

function ms(value: Date | string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? undefined : parsed
}

function date(value: number | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value)
}

export function agentTeamToRow(team: AgentTeam, updatedAt = Date.now()): AgentTeamRow {
  const { createdAt, completedAt, ...rest } = team
  return {
    ...rest,
    createdAt: ms(createdAt) ?? 0,
    ...(ms(completedAt) !== undefined ? { completedAt: ms(completedAt)! } : {}),
    updatedAt,
  }
}

export function agentTeamFromRow(row: AgentTeamRow): AgentTeam {
  const { createdAt, completedAt, updatedAt: _updatedAt, ...rest } = row
  return {
    ...rest,
    createdAt: new Date(createdAt),
    ...(completedAt !== undefined ? { completedAt: date(completedAt)! } : {}),
  } as AgentTeam
}

export function agentTeammateToRow(
  teammate: AgentTeammate,
  updatedAt = Date.now()
): AgentTeammateRow {
  return { ...teammate, createdAt: ms(teammate.createdAt) ?? 0, updatedAt }
}

export function agentTeammateFromRow(row: AgentTeammateRow): AgentTeammate {
  const { updatedAt: _updatedAt, ...rest } = row
  return { ...rest, createdAt: new Date(row.createdAt) } as AgentTeammate
}

export function agentTeamTaskToRow(task: AgentTeamTask, updatedAt = Date.now()): AgentTeamTaskRow {
  const { createdAt, completedAt, startedAt, ...rest } = task
  return {
    ...rest,
    createdAt: ms(createdAt) ?? 0,
    ...(ms(completedAt) !== undefined ? { completedAt: ms(completedAt)! } : {}),
    ...(ms(startedAt) !== undefined ? { startedAt: ms(startedAt)! } : {}),
    updatedAt,
  }
}

export function agentTeamTaskFromRow(row: AgentTeamTaskRow): AgentTeamTask {
  const { createdAt, completedAt, startedAt, updatedAt: _updatedAt, ...rest } = row
  return {
    ...rest,
    createdAt: new Date(createdAt),
    ...(completedAt !== undefined ? { completedAt: date(completedAt)! } : {}),
    ...(startedAt !== undefined ? { startedAt: date(startedAt)! } : {}),
  } as AgentTeamTask
}

/**
 * Every stored squad, with its teammates and tasks.
 *
 * Read whole rather than per workspace: the store is one in-memory projection
 * of the account, and the three list surfaces already apply the workspace
 * filter themselves. Scoping the read here would make switching workspaces a
 * database round trip and would hide a squad from the run it is executing.
 */
export async function loadAgentTeamDefinitions(): Promise<{
  teams: AgentTeam[]
  teammates: AgentTeammate[]
  tasks: AgentTeamTask[]
}> {
  const db = getDb()
  const [teams, teammates, tasks] = await Promise.all([
    db.agentTeams.toArray(),
    db.agentTeammates.toArray(),
    db.agentTeamTasks.toArray(),
  ])
  return {
    teams: teams.map(agentTeamFromRow),
    teammates: teammates.map(agentTeammateFromRow),
    tasks: tasks.map(agentTeamTaskFromRow),
  }
}

/** Squads belonging to one workspace, plus any that predate the column. */
export async function listAgentTeamsByWorkspace(projectId: string): Promise<AgentTeam[]> {
  const rows = await getDb().agentTeams.toArray()
  return rows
    .filter((row) => row.projectId === undefined || row.projectId === projectId)
    .map(agentTeamFromRow)
}

/**
 * Replace the stored definitions with exactly what is passed.
 *
 * One transaction across the three tables so a half-written squad, one with a
 * lead its roster no longer contains, can never be observed. `bulkPut` plus a
 * delete of what is no longer named is what makes this a mirror rather than an
 * append log.
 */
export async function writeAgentTeamDefinitions(input: {
  teams: AgentTeam[]
  teammates: AgentTeammate[]
  tasks: AgentTeamTask[]
  deleteTeamIds?: string[]
  deleteTeammateIds?: string[]
  deleteTaskIds?: string[]
  /** Injected in tests so a write has a deterministic cursor value. */
  now?: number
}): Promise<void> {
  const db = getDb()
  const stamp = input.now ?? Date.now()
  await db.transaction("rw", db.agentTeams, db.agentTeammates, db.agentTeamTasks, async () => {
    if (input.deleteTeamIds?.length) await db.agentTeams.bulkDelete(input.deleteTeamIds)
    if (input.deleteTeammateIds?.length) {
      await db.agentTeammates.bulkDelete(input.deleteTeammateIds)
    }
    if (input.deleteTaskIds?.length) await db.agentTeamTasks.bulkDelete(input.deleteTaskIds)
    if (input.teams.length) {
      await db.agentTeams.bulkPut(input.teams.map((team) => agentTeamToRow(team, stamp)))
    }
    if (input.teammates.length) {
      await db.agentTeammates.bulkPut(
        input.teammates.map((teammate) => agentTeammateToRow(teammate, stamp))
      )
    }
    if (input.tasks.length) {
      await db.agentTeamTasks.bulkPut(input.tasks.map((task) => agentTeamTaskToRow(task, stamp)))
    }
  })
}

/** Drop one workspace's squads and everything hanging off them. */
export async function deleteAgentTeamsForWorkspace(projectId: string): Promise<number> {
  const db = getDb()
  return db.transaction("rw", db.agentTeams, db.agentTeammates, db.agentTeamTasks, async () => {
    const teams = (await db.agentTeams.toArray()).filter((row) => row.projectId === projectId)
    const ids = teams.map((row) => row.id)
    if (ids.length === 0) return 0
    await db.agentTeams.bulkDelete(ids)
    await db.agentTeammates.where("teamId").anyOf(ids).delete()
    await db.agentTeamTasks.where("teamId").anyOf(ids).delete()
    return ids.length
  })
}
