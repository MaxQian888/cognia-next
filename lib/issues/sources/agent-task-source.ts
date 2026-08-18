/**
 * Agent-task source — READ-ONLY federated adapter over single-agent tasks
 * (`agentTasks`, `lib/db/agent-tasks.ts`; ADR-0132 slice ③).
 *
 * Projects each workspace-scoped AgentTask onto the board so the "one total
 * board" promise holds: a task an agent is running shows up next to the issue
 * it came from instead of living only on the Character's own task board.
 * Every capability is off — the AgentTask runtime owns these rows, and the
 * board must grey the affordances out rather than fail at write time.
 *
 * Rows that were dispatched FROM an issue (via `lib/issues/run/`) inherit that
 * issue's delivery container and carry its identifier in `origin.sourceLabel`
 * ("Agent Task · MERC-2"), so the card reads as what it is: the engine side of
 * a run, not a second issue.
 */

import type { AgentTask } from "@/types/agent/agent-task"
import type { IssueRun } from "@/types/issues"
import { statusCategoryOf } from "@/types/issues"
import type { IssueSourceAdapter, IssueSourceQuery, UnifiedIssueItem } from "@/types/issues/unified"
import { makeUnifiedIssueId, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { listAgentTasksByProject } from "@/lib/db/agent-tasks"
import { mapIssueRunsByTarget } from "@/lib/db/issue-runs"
import { AGENT_TASK_BOARD_HREF } from "@/lib/issues/run/agent-task-adapter"
import { agentTaskPriorityToIssuePriority, agentTaskStatusToIssueStatus } from "./agent-status-map"
import { getIssueSourceRegistry, type IssueSourceRegistry } from "./registry"

export const AGENT_TASK_SOURCE_LABEL = "Agent Task"

/** What a federated agent row needs to know about the issue it came from. */
export interface OriginIssueRef {
  identifier: string
  issueProjectId: string
}

/** Badge text: the source, plus the originating issue's identifier when known. */
export function agentSourceLabel(base: string, origin: OriginIssueRef | undefined): string {
  return origin ? `${base} · ${origin.identifier}` : base
}

/** Project a stored AgentTask into the board's normalized shape. */
export function toUnifiedAgentTask(task: AgentTask, origin?: OriginIssueRef): UnifiedIssueItem {
  const status = agentTaskStatusToIssueStatus(task.status)
  return {
    unifiedId: makeUnifiedIssueId("agent-task", task.id),
    kind: "agent-task",
    sourceId: task.id,
    // AgentTasks have no printed identifier; the id tail keeps cards distinguishable.
    identifier: `task ${task.id.replace(/^agent-task:/, "").slice(0, 8)}`,
    title: task.title,
    ...(task.description ? { description: task.description } : {}),
    status,
    statusCategory: statusCategoryOf(status),
    priority: agentTaskPriorityToIssuePriority(task.priority),
    assignee: { kind: "agent", id: task.agentId },
    // No meaningful author: the task was filed by whoever drove the agent.
    labelIds: [],
    ...(origin ? { issueProjectId: origin.issueProjectId } : {}),
    order: task.order,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    origin: {
      tableName: "agentTasks",
      deepLinkHref: AGENT_TASK_BOARD_HREF,
      sourceLabel: agentSourceLabel(AGENT_TASK_SOURCE_LABEL, origin),
    },
    capabilities: READ_ONLY_ISSUE_CAPABILITIES,
  }
}

export interface AgentTaskSourceDeps {
  listTasks: (projectId: string) => Promise<AgentTask[]>
  runsByTarget: (projectId: string) => Promise<Map<string, IssueRun>>
  /** Resolve issue ids to what the badge and container grouping need. */
  originRefsOf: (issueIds: readonly string[]) => Promise<Map<string, OriginIssueRef>>
}

/** Shared by both agent sources: look the originating issues up in one query. */
export async function loadOriginIssueRefs(
  issueIds: readonly string[]
): Promise<Map<string, OriginIssueRef>> {
  if (issueIds.length === 0) return new Map()
  const { getDb } = await import("@/lib/db/schema")
  const rows = await getDb()
    .issues.where("id")
    .anyOf([...issueIds])
    .toArray()
  return new Map(
    rows.map((row) => [row.id, { identifier: row.identifier, issueProjectId: row.issueProjectId }])
  )
}

const defaultDeps: AgentTaskSourceDeps = {
  listTasks: listAgentTasksByProject,
  runsByTarget: (projectId) => mapIssueRunsByTarget(projectId, "agent-task"),
  originRefsOf: loadOriginIssueRefs,
}

export function createAgentTaskIssueSource(
  overrides: Partial<AgentTaskSourceDeps> = {}
): IssueSourceAdapter {
  const deps = { ...defaultDeps, ...overrides }
  return {
    kind: "agent-task",
    label: AGENT_TASK_SOURCE_LABEL,
    async list(query: IssueSourceQuery): Promise<UnifiedIssueItem[]> {
      const [tasks, runs] = await Promise.all([
        deps.listTasks(query.projectId),
        deps.runsByTarget(query.projectId),
      ])
      const origins = await deps.originRefsOf([
        ...new Set([...runs.values()].map((run) => run.issueId)),
      ])
      const items: UnifiedIssueItem[] = []
      for (const task of tasks) {
        const run = runs.get(task.id)
        const origin = run ? origins.get(run.issueId) : undefined
        // AgentTasks know no delivery container of their own; under a
        // container-scoped query only the rows dispatched from that
        // container's issues belong.
        if (query.issueProjectId && origin?.issueProjectId !== query.issueProjectId) continue
        items.push(toUnifiedAgentTask(task, origin))
      }
      return items
    },
  }
}

export const agentTaskIssueSource: IssueSourceAdapter = createAgentTaskIssueSource()

export function registerAgentTaskIssueSource(
  registry: IssueSourceRegistry = getIssueSourceRegistry(),
  source: IssueSourceAdapter = agentTaskIssueSource
) {
  registry.register(source)
}
