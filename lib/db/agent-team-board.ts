/**
 * Dexie accessor for the Agent-Team board projection (team-board CQRS).
 *
 * The agent-team-store (localStorage-persisted Zustand) is the SINGLE write
 * source for teams/tasks; this table is a one-way mirror maintained by
 * `lib/db/agent-team-projection.ts` on the desktop so the companion sync
 * pipeline can carry the task board to the phone. Two row kinds share the
 * table:
 *   - task rows (`kind: "task"`, id = taskId) — the board card payload;
 *   - team-meta rows (`kind: "team"`, id = `team:<teamId>`) — team status +
 *     roster, which the mobile board needs for swimlanes and for evaluating
 *     `allowedMoveTargets` before offering an action-sheet move.
 *
 * All timestamps are epoch ms (rows cross the sync wire as JSON). Free-text
 * payloads are capped (comments) / truncated (result/error previews) — the
 * phone renders a board, not an archive.
 *
 * Table declared in `lib/db/schema.ts` v104.
 */

import type {
  AgentTeam,
  AgentTeammate,
  AgentTeamTask,
  TeammateStatus,
  TeamStatus,
  TeamTaskStatus,
} from "@/types/agent/agent-team"
import type { SubAgentPriority } from "@/types/agent/sub-agent"
import { getDb } from "./schema"

/** Comments carried per task row (newest last, older ones dropped). */
export const BOARD_COMMENTS_CAP = 20
/** Truncation cap for result/error previews. */
export const BOARD_PREVIEW_CAP = 500

export interface AgentTeamBoardComment {
  id: string
  authorId: string
  authorName: string
  text: string
  createdAt: number
}

export interface AgentTeamBoardTaskRow {
  /** = taskId. */
  id: string
  kind: "task"
  teamId: string
  title: string
  description: string
  status: TeamTaskStatus
  priority: SubAgentPriority
  assignedTo?: string
  claimedBy?: string
  dependencies: string[]
  tags: string[]
  order: number
  commentCount: number
  /** Newest-last thread, capped to {@link BOARD_COMMENTS_CAP}. */
  comments: AgentTeamBoardComment[]
  attachmentsCount: number
  errorPreview?: string
  resultPreview?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  updatedAt: number
}

export interface AgentTeamBoardTeammate {
  id: string
  name: string
  role: AgentTeammate["role"]
  status: TeammateStatus
  twinId?: string
}

export interface AgentTeamBoardTeamRow {
  /** `team:<teamId>`. */
  id: string
  kind: "team"
  teamId: string
  name: string
  status: TeamStatus
  /** Concurrency capacity, for the mobile WIP hint. */
  maxConcurrentTeammates: number
  teammates: AgentTeamBoardTeammate[]
  knowledgeTwinIds: string[]
  updatedAt: number
}

export type AgentTeamBoardRow = AgentTeamBoardTaskRow | AgentTeamBoardTeamRow

export function teamMetaRowId(teamId: string): string {
  return `team:${teamId}`
}

const toEpoch = (value: Date | number | undefined): number | undefined =>
  value === undefined ? undefined : new Date(value).getTime()

const truncate = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : value.slice(0, BOARD_PREVIEW_CAP)

/** Project a store task into its board row (timestamps → epoch ms). */
export function boardRowFromTask(task: AgentTeamTask, updatedAt: number): AgentTeamBoardTaskRow {
  const comments = (task.comments ?? []).slice(-BOARD_COMMENTS_CAP).map((c) => ({
    id: c.id,
    authorId: c.authorId,
    authorName: c.authorName,
    text: c.text.slice(0, BOARD_PREVIEW_CAP),
    createdAt: toEpoch(c.createdAt) ?? updatedAt,
  }))
  return {
    id: task.id,
    kind: "task",
    teamId: task.teamId,
    title: task.title,
    description: task.description.slice(0, BOARD_PREVIEW_CAP),
    status: task.status,
    priority: task.priority,
    ...(task.assignedTo !== undefined ? { assignedTo: task.assignedTo } : {}),
    ...(task.claimedBy !== undefined ? { claimedBy: task.claimedBy } : {}),
    dependencies: [...task.dependencies],
    tags: [...task.tags],
    order: task.order,
    commentCount: task.comments?.length ?? 0,
    comments,
    attachmentsCount: task.attachments?.length ?? 0,
    ...(task.error !== undefined ? { errorPreview: truncate(task.error) } : {}),
    ...(task.result !== undefined ? { resultPreview: truncate(task.result) } : {}),
    createdAt: toEpoch(task.createdAt) ?? updatedAt,
    ...(task.startedAt !== undefined ? { startedAt: toEpoch(task.startedAt) } : {}),
    ...(task.completedAt !== undefined ? { completedAt: toEpoch(task.completedAt) } : {}),
    updatedAt,
  }
}

/** Project a store team + its roster into the board's team-meta row. */
export function boardRowFromTeam(
  team: AgentTeam,
  teammates: readonly AgentTeammate[],
  updatedAt: number
): AgentTeamBoardTeamRow {
  return {
    id: teamMetaRowId(team.id),
    kind: "team",
    teamId: team.id,
    name: team.name,
    status: team.status,
    maxConcurrentTeammates: team.config.maxConcurrentTeammates ?? 1,
    teammates: teammates.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      status: m.status,
      ...(m.config?.twinId ? { twinId: m.config.twinId } : {}),
    })),
    knowledgeTwinIds: [...(team.config.knowledgeTwinIds ?? [])],
    updatedAt,
  }
}

export async function putAgentTeamBoardRows(rows: AgentTeamBoardRow[]): Promise<void> {
  if (rows.length === 0) return
  await getDb().agentTeamBoard.bulkPut(rows)
}

export async function deleteAgentTeamBoardRows(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await getDb().agentTeamBoard.bulkDelete(ids)
}

/** Every row (tasks + the meta row) for one team. */
export async function listAgentTeamBoardRows(teamId: string): Promise<AgentTeamBoardRow[]> {
  return getDb().agentTeamBoard.where("teamId").equals(teamId).toArray()
}

/** All row ids currently in the projection (install-time reconcile). */
export async function listAgentTeamBoardIds(): Promise<string[]> {
  return (await getDb().agentTeamBoard.toCollection().primaryKeys()) as string[]
}

export async function getAgentTeamBoardTeamRow(
  teamId: string
): Promise<AgentTeamBoardTeamRow | undefined> {
  const row = await getDb().agentTeamBoard.get(teamMetaRowId(teamId))
  return row?.kind === "team" ? row : undefined
}
