/**
 * Agent-team source — READ-ONLY federated adapter over Agent Team tasks
 * (`stores/agent/agent-team-store`; ADR-0132 slice ③, ADR-0066 for the board
 * it mirrors).
 *
 * Reads the zustand store, NOT the `agentTeamBoard` Dexie projection: the
 * projection is desktop-only and lossy (500-char previews, no metadata), and
 * the store is where `metadata.issueId` — the "from MERC-2" badge — lives.
 * Teams are scoped to the workspace by `AgentTeam.projectId` (pre-v86 teams
 * carrying no `projectId` are backfilled by the store's persist migration).
 *
 * Every capability is off. The team runtime owns these rows
 * (`lib/ai/agent/team/task-move-guard.ts`); moving them lives on the team
 * board, and the card deep-links there.
 */

import type { AgentTeam, AgentTeamTask } from "@/types/agent/agent-team"
import type { IssueRun } from "@/types/issues"
import { statusCategoryOf } from "@/types/issues"
import type { IssueSourceAdapter, IssueSourceQuery, UnifiedIssueItem } from "@/types/issues/unified"
import { makeUnifiedIssueId, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { mapIssueRunsByTarget } from "@/lib/db/issue-runs"
import { agentTeamWorkspaceHref } from "@/lib/issues/run/agent-team-adapter"
import { subAgentPriorityToIssuePriority, teamTaskStatusToIssueStatus } from "./agent-status-map"
import { agentSourceLabel, loadOriginIssueRefs, type OriginIssueRef } from "./agent-task-source"
import { getIssueSourceRegistry, type IssueSourceRegistry } from "./registry"

export const AGENT_TEAM_SOURCE_LABEL = "Agent Team"

function toMs(value: Date | number | undefined): number {
  if (value === undefined) return 0
  return value instanceof Date ? value.getTime() : value
}

/** `metadata.issueId` stamped by the run adapter, when present. */
export function teamTaskIssueId(task: AgentTeamTask): string | undefined {
  const value = task.metadata?.issueId
  return typeof value === "string" && value ? value : undefined
}

/** Project a team task into the board's normalized shape. */
export function toUnifiedTeamTask(
  task: AgentTeamTask,
  team: Pick<AgentTeam, "id" | "name">,
  origin?: OriginIssueRef
): UnifiedIssueItem {
  const status = teamTaskStatusToIssueStatus(task.status)
  const createdAt = toMs(task.createdAt)
  const updatedAt = Math.max(createdAt, toMs(task.startedAt), toMs(task.completedAt))
  return {
    unifiedId: makeUnifiedIssueId("agent-team", task.id),
    kind: "agent-team",
    sourceId: task.id,
    identifier: `${team.name} · #${task.order + 1}`,
    title: task.title,
    ...(task.description ? { description: task.description } : {}),
    status,
    statusCategory: statusCategoryOf(status),
    priority: subAgentPriorityToIssuePriority(task.priority),
    assignee: { kind: "team", id: team.id, label: team.name },
    labelIds: [],
    ...(origin ? { issueProjectId: origin.issueProjectId } : {}),
    order: task.order,
    createdAt,
    updatedAt,
    origin: {
      deepLinkHref: agentTeamWorkspaceHref(team.id),
      sourceLabel: agentSourceLabel(AGENT_TEAM_SOURCE_LABEL, origin),
    },
    capabilities: READ_ONLY_ISSUE_CAPABILITIES,
  }
}

export interface AgentTeamSourceDeps {
  /** Teams + tasks snapshot for a workspace. */
  readTeams: (projectId: string) => Promise<Array<{ team: AgentTeam; tasks: AgentTeamTask[] }>>
  runsByTarget: (projectId: string) => Promise<Map<string, IssueRun>>
  originRefsOf: (issueIds: readonly string[]) => Promise<Map<string, OriginIssueRef>>
}

async function defaultReadTeams(projectId: string) {
  const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
  const state = useAgentTeamStore.getState()
  const teams = Object.values(state.teams).filter((team) => team.projectId === projectId)
  return teams.map((team) => ({
    team,
    tasks: Object.values(state.tasks).filter((task) => task.teamId === team.id),
  }))
}

const defaultDeps: AgentTeamSourceDeps = {
  readTeams: defaultReadTeams,
  runsByTarget: (projectId) => mapIssueRunsByTarget(projectId, "agent-team"),
  originRefsOf: loadOriginIssueRefs,
}

export function createAgentTeamIssueSource(
  overrides: Partial<AgentTeamSourceDeps> = {}
): IssueSourceAdapter {
  const deps = { ...defaultDeps, ...overrides }
  return {
    kind: "agent-team",
    label: AGENT_TEAM_SOURCE_LABEL,
    async list(query: IssueSourceQuery): Promise<UnifiedIssueItem[]> {
      const teams = await deps.readTeams(query.projectId)
      if (teams.length === 0) return []
      // Origin comes from the task's own metadata first (stamped by the run
      // adapter), falling back to the run row for tasks whose metadata was
      // lost — both point at the same issue.
      const runs = await deps.runsByTarget(query.projectId)
      const runByTaskId = new Map<string, IssueRun>()
      for (const run of runs.values()) {
        const taskId = run.targetRef?.taskId
        if (taskId) runByTaskId.set(taskId, run)
      }
      const issueIds = new Set<string>()
      for (const { tasks } of teams) {
        for (const task of tasks) {
          const id = teamTaskIssueId(task) ?? runByTaskId.get(task.id)?.issueId
          if (id) issueIds.add(id)
        }
      }
      const origins = await deps.originRefsOf([...issueIds])
      const items: UnifiedIssueItem[] = []
      for (const { team, tasks } of teams) {
        for (const task of tasks) {
          const issueId = teamTaskIssueId(task) ?? runByTaskId.get(task.id)?.issueId
          const origin = issueId ? origins.get(issueId) : undefined
          if (query.issueProjectId && origin?.issueProjectId !== query.issueProjectId) continue
          items.push(toUnifiedTeamTask(task, team, origin))
        }
      }
      return items
    },
  }
}

export const agentTeamIssueSource: IssueSourceAdapter = createAgentTeamIssueSource()

export function registerAgentTeamIssueSource(
  registry: IssueSourceRegistry = getIssueSourceRegistry(),
  source: IssueSourceAdapter = agentTeamIssueSource
) {
  registry.register(source)
}
