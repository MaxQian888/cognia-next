/**
 * The agents working in a workspace right now: the ONE source behind both the
 * `/workspace` "Agents working" tile's number and the list it opens.
 *
 * The tile used to be `listActiveIssueRunIssueIds(projectId).size`, a bare
 * count with nothing behind it. The Tauri audit found "Agents working 2" on a
 * workspace with zero open issues and no way to see which two. Counting and
 * listing from separate queries is how a badge and its drill-down drift apart,
 * so the tile now renders `listActiveAgentRuns(...).length` and the list
 * renders the same array.
 *
 * Semantics are unchanged from the old count: one entry per issue with an
 * active (`queued` / `running`) issue run, i.e. exactly the set
 * `listActiveIssueRunIssueIds` returns. When an issue somehow has two active
 * runs the newest one represents it.
 *
 * Each entry carries where to watch it, by run kind:
 * - `agent-task`  → the newest attempt's chat session; before the first
 *                   attempt has a session, the Character task board.
 * - `agent-team`  → the Squad workspace for the team.
 * - `github-loop` → the issue itself (its detail panel shows the live run).
 */

import { getIssue } from "@/lib/db/issues"
import { listIssueRuns } from "@/lib/db/issue-runs"
import { listAgentTaskAttempts } from "@/lib/db/agent-tasks"
import { issueHref } from "@/lib/issues/hrefs"
import {
  AGENT_TASK_BOARD_HREF,
  AGENT_TASK_RUN_ADAPTER_ID,
  sessionHref,
} from "@/lib/issues/run/agent-task-adapter"
import {
  AGENT_TEAM_RUN_ADAPTER_ID,
  agentTeamWorkspaceHref,
} from "@/lib/issues/run/agent-team-adapter"
import type { Issue, IssueRun, IssueRunKind } from "@/types/issues"

/** What an entry's primary link opens. Drives the link label. */
export type ActiveAgentRunLinkKind = "session" | "squad" | "agent-board" | "issue"

export interface ActiveAgentRun {
  runId: string
  issueId: string
  /** `KEY-12`, when the issue row still exists. */
  issueIdentifier?: string
  issueTitle?: string
  /** `IssueRunAdapter.id` — also the i18n key of the engine's display name. */
  adapterId: string
  kind: IssueRunKind
  status: "queued" | "running"
  startedAt: number
  /** Where to watch this run. */
  href: string
  linkKind: ActiveAgentRunLinkKind
  /** The issue the run was dispatched from. */
  issueHref: string
}

export interface ActiveAgentRunDeps {
  /** Active runs of the workspace, newest first. */
  listActiveRuns: (projectId: string) => Promise<IssueRun[]>
  getIssue: (issueId: string) => Promise<Issue | undefined>
  /** Newest chat session of an AgentTask's attempts, if any attempt has one. */
  latestTaskSessionId: (taskId: string) => Promise<string | undefined>
}

async function defaultListActiveRuns(projectId: string): Promise<IssueRun[]> {
  // Two indexed reads on `[projectId+status]` rather than a full workspace
  // scan filtered in memory: history grows forever, active runs stay few.
  const [queued, running] = await Promise.all([
    listIssueRuns({ projectId, status: "queued" }),
    listIssueRuns({ projectId, status: "running" }),
  ])
  return [...queued, ...running].sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1))
}

async function defaultLatestTaskSessionId(taskId: string): Promise<string | undefined> {
  const attempts = await listAgentTaskAttempts(taskId)
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const sessionId = attempts[index].sessionId
    if (sessionId) return sessionId
  }
  return undefined
}

const defaultDeps: ActiveAgentRunDeps = {
  listActiveRuns: defaultListActiveRuns,
  getIssue,
  latestTaskSessionId: defaultLatestTaskSessionId,
}

async function watchLink(
  run: IssueRun,
  deps: ActiveAgentRunDeps
): Promise<{ href: string; linkKind: ActiveAgentRunLinkKind }> {
  if (run.adapterId === AGENT_TASK_RUN_ADAPTER_ID) {
    const sessionId = await deps.latestTaskSessionId(run.targetId)
    return sessionId
      ? { href: sessionHref(sessionId), linkKind: "session" }
      : { href: AGENT_TASK_BOARD_HREF, linkKind: "agent-board" }
  }
  if (run.adapterId === AGENT_TEAM_RUN_ADAPTER_ID) {
    return { href: agentTeamWorkspaceHref(run.targetId), linkKind: "squad" }
  }
  return { href: issueHref(run.issueId), linkKind: "issue" }
}

/** One entry per issue with an active run, newest run first. */
export async function listActiveAgentRuns(
  projectId: string,
  deps: ActiveAgentRunDeps = defaultDeps
): Promise<ActiveAgentRun[]> {
  const runs = await deps.listActiveRuns(projectId)
  const newestPerIssue: IssueRun[] = []
  const seen = new Set<string>()
  for (const run of runs) {
    if (run.status !== "queued" && run.status !== "running") continue
    if (seen.has(run.issueId)) continue
    seen.add(run.issueId)
    newestPerIssue.push(run)
  }

  return Promise.all(
    newestPerIssue.map(async (run): Promise<ActiveAgentRun> => {
      const [issue, link] = await Promise.all([deps.getIssue(run.issueId), watchLink(run, deps)])
      return {
        runId: run.id,
        issueId: run.issueId,
        issueIdentifier: issue?.identifier,
        issueTitle: issue?.title,
        adapterId: run.adapterId,
        kind: run.kind,
        status: run.status as ActiveAgentRun["status"],
        startedAt: run.startedAt,
        href: link.href,
        linkKind: link.linkKind,
        issueHref: issueHref(run.issueId),
      }
    })
  )
}
