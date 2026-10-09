/**
 * What an agent is doing, did, and cost (ADR-0220), derived from rows that
 * already exist: conversations bound to it, its durable tasks, the issues
 * assigned to it, its spend rows, and each conversation's live run status.
 *
 * Pure, so the table, the overview and the work tab compute the same answer,
 * and so it is testable without a database or a chat store.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { AgentTask } from "@/types/agent/agent-task"
import type { Issue } from "@/types/issues"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { AgentSessionSummaryRow } from "@/lib/db/agent-activity"

/** A live conversation status, as the chat store reports it. */
export type AgentRunStatus = "streaming" | "awaiting_approval" | "error"

/** The single word the console shows for an agent. */
export type AgentLiveStatus = "running" | "awaiting" | "idle"

export const ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

const ACTIVE_TASK_STATUSES: ReadonlySet<AgentTask["status"]> = new Set(["in_progress", "review"])
const FINISHED_TASK_STATUSES: ReadonlySet<AgentTask["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
])

/** When a conversation was last active: its last message, else its last write. */
export function sessionActivityAt(
  session: Pick<ChatSession, "lastMessageAt" | "updatedAt">
): number {
  return session.lastMessageAt ?? session.updatedAt
}

/**
 * `awaiting` outranks `running`: an agent waiting on an approval is the one
 * that needs a person, and the table should say so even if another of its
 * conversations is also streaming.
 */
export function liveStatusOf(
  sessionIds: Iterable<string>,
  runStatus: ReadonlyMap<string, AgentRunStatus>,
  tasks: readonly Pick<AgentTask, "status">[] = []
): AgentLiveStatus {
  let running = false
  for (const id of sessionIds) {
    const status = runStatus.get(id)
    if (status === "awaiting_approval") return "awaiting"
    if (status === "streaming") running = true
  }
  if (running) return "running"
  return tasks.some((task) => task.status === "in_progress") ? "running" : "idle"
}

export type AgentNowItem =
  | { kind: "session"; session: ChatSession; status: AgentRunStatus }
  | { kind: "task"; task: AgentTask }

export type AgentRecentItem =
  | { kind: "session"; session: ChatSession; at: number }
  | { kind: "task"; task: AgentTask; at: number }
  | { kind: "issue"; issue: Issue; at: number }

export interface AgentStats {
  conversations: number
  turns: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  completedTasks: number
  completedIssues: number
}

export interface AgentActivity {
  status: AgentLiveStatus
  now: AgentNowItem[]
  recent: AgentRecentItem[]
  /** Durable tasks that are not finished (anything short of completed, failed, cancelled), most recently touched first. */
  openTasks: AgentTask[]
  /** Issues assigned to the agent that are not finished, most recently touched first. */
  openIssues: Issue[]
  lastActiveAt?: number
  stats: AgentStats
}

export interface AgentActivityInputs {
  sessions: readonly ChatSession[]
  tasks: readonly AgentTask[]
  issues: readonly Issue[]
  /** Spend rows inside the window. */
  usage: readonly SessionUsageRow[]
  runStatus: ReadonlyMap<string, AgentRunStatus>
  now: number
  /** How many recent items to keep. */
  recentLimit?: number
}

export function deriveAgentActivity(input: AgentActivityInputs): AgentActivity {
  const since = input.now - ACTIVITY_WINDOW_MS
  const live: AgentNowItem[] = []
  for (const session of input.sessions) {
    const status = input.runStatus.get(session.id)
    if (status === "streaming" || status === "awaiting_approval") {
      live.push({ kind: "session", session, status })
    }
  }
  for (const task of input.tasks) {
    if (ACTIVE_TASK_STATUSES.has(task.status)) live.push({ kind: "task", task })
  }

  const recent: AgentRecentItem[] = [
    ...input.tasks
      .filter((task) => task.status === "completed")
      .map((task) => ({ kind: "task" as const, task, at: task.updatedAt })),
    ...input.issues
      .filter((issue) => issue.statusCategory === "completed")
      .map((issue) => ({
        kind: "issue" as const,
        issue,
        at: issue.completedAt ?? issue.updatedAt,
      })),
    ...input.sessions
      .filter(
        (session) => !live.some((item) => item.kind === "session" && item.session.id === session.id)
      )
      .map((session) => ({ kind: "session" as const, session, at: sessionActivityAt(session) })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, input.recentLimit ?? 10)

  const openTasks = input.tasks
    .filter((task) => !FINISHED_TASK_STATUSES.has(task.status))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const openIssues = input.issues
    .filter((issue) => issue.statusCategory !== "completed" && issue.statusCategory !== "canceled")
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const candidates = [
    ...input.sessions.map(sessionActivityAt),
    ...input.tasks.map((task) => task.updatedAt),
    ...input.issues.map((issue) => issue.updatedAt),
    ...input.usage.map((row) => row.at),
  ]
  const lastActiveAt = candidates.length > 0 ? Math.max(...candidates) : undefined

  const inWindow = input.usage.filter((row) => row.at >= since)
  const stats: AgentStats = {
    conversations: input.sessions.filter((session) => sessionActivityAt(session) >= since).length,
    turns: inWindow.length,
    inputTokens: inWindow.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: inWindow.reduce((sum, row) => sum + row.outputTokens, 0),
    costUsd: inWindow.reduce((sum, row) => sum + row.costUsd, 0),
    completedTasks: input.tasks.filter(
      (task) => task.status === "completed" && task.updatedAt >= since
    ).length,
    completedIssues: input.issues.filter(
      (issue) =>
        issue.statusCategory === "completed" && (issue.completedAt ?? issue.updatedAt) >= since
    ).length,
  }

  return {
    status: liveStatusOf(
      input.sessions.map((session) => session.id),
      input.runStatus,
      input.tasks
    ),
    now: live,
    recent,
    openTasks,
    openIssues,
    lastActiveAt,
    stats,
  }
}

/** One agent's row in the agents list. */
export interface AgentSummary {
  status: AgentLiveStatus
  lastActiveAt?: number
  /** Turns in the window. */
  turns: number
  conversations: number
}

/** Summaries for every agent from one read of all agent-bound rows. */
export function summarizeAgents(
  agentIds: readonly string[],
  sessions: readonly AgentSessionSummaryRow[],
  usage: readonly { characterId?: string; at: number }[],
  runStatus: ReadonlyMap<string, AgentRunStatus>,
  now: number
): Map<string, AgentSummary> {
  const since = now - ACTIVITY_WINDOW_MS
  const sessionsByAgent = new Map<string, AgentSessionSummaryRow[]>()
  for (const session of sessions) {
    if (!session.characterId) continue
    const list = sessionsByAgent.get(session.characterId) ?? []
    list.push(session)
    sessionsByAgent.set(session.characterId, list)
  }
  const usageByAgent = new Map<string, { turns: number; lastAt: number }>()
  for (const row of usage) {
    if (!row.characterId || row.at < since) continue
    const entry = usageByAgent.get(row.characterId) ?? { turns: 0, lastAt: 0 }
    entry.turns += 1
    entry.lastAt = Math.max(entry.lastAt, row.at)
    usageByAgent.set(row.characterId, entry)
  }
  const out = new Map<string, AgentSummary>()
  for (const id of agentIds) {
    const own = sessionsByAgent.get(id) ?? []
    const spend = usageByAgent.get(id)
    const times = [...own.map(sessionActivityAt), ...(spend ? [spend.lastAt] : [])]
    out.set(id, {
      status: liveStatusOf(
        own.map((s) => s.id),
        runStatus
      ),
      lastActiveAt: times.length > 0 ? Math.max(...times) : undefined,
      turns: spend?.turns ?? 0,
      conversations: own.filter((s) => sessionActivityAt(s) >= since).length,
    })
  }
  return out
}
