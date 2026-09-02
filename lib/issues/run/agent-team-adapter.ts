/**
 * `team` assignee → AgentTeam run (`lib/ai/agent/agent-team.ts`).
 *
 * The issue's `team` assignee id is an `AgentTeam` id. The adapter appends one
 * `AgentTeamTask` to the team (with `metadata.issueId` so the team board can
 * badge it "from KEY-1"), then starts the team. `agentTeamManager.start`
 * snapshots the team's task list when it begins, so a team that is already
 * executing / planning / paused cannot take a new task mid-run — the adapter
 * refuses with `team-busy` rather than adding a task nobody will pick up.
 *
 * `start()` resolves only when the team run is terminal, so the adapter fires
 * it without awaiting and lets `poll` (driven by the store subscription in
 * `install.ts`) settle the run from the task's own status. That also covers a
 * reload mid-run: the awaiting promise is gone but the task row is not.
 *
 * Artifacts come from the durable-v2 tables when the team wrote them (delivery
 * nodes → PR urls; child runs → branch / worktree) — legacy runs simply have
 * none beyond the team workspace link.
 */

import type { AgentTeam, AgentTeamTask, CreateTaskInput } from "@/types/agent/agent-team"
import type { IssueRun, IssueRunArtifact } from "@/types/issues"
import { createIssueRun } from "@/lib/db/issue-runs"
import {
  getAgentTeamDeliveryGraph,
  listAgentTeamChildRuns,
  listAgentTeamDeliveryNodes,
  listAgentTeamRuns,
} from "@/lib/db/agent-team-runtime"
import type {
  IssueRunAdapter,
  IssueRunOrigin,
  IssueRunPollResult,
  IssueRunStartContext,
  IssueRunTarget,
  IssueRunVerdict,
} from "./types"

export const AGENT_TEAM_RUN_ADAPTER_ID = "agent-team"

/** Team workspace deep link — query param, never `[id]` (static export). */
export function agentTeamWorkspaceHref(teamId: string): string {
  return `/squads?id=${encodeURIComponent(teamId)}`
}

/**
 * Where an agent branch left behind by a run can actually be seen.
 *
 * `AgentBranchesSection` is rendered by `/workspace`'s Environments tab, and
 * `?tab=` is real URL state there. Branches outlive the worktrees they came
 * from and are scoped to the repository rather than to one Squad, which is why
 * this carries no team id.
 */
export const AGENT_BRANCHES_HREF = "/workspace?tab=environments"

/** Team statuses during which the task snapshot is fixed. */
export const BUSY_TEAM_STATUSES: ReadonlySet<AgentTeam["status"]> = new Set([
  "planning",
  "executing",
  "paused",
])

export interface AgentTeamRunAdapterDeps {
  getTeam: (teamId: string) => AgentTeam | undefined
  getTask: (taskId: string) => AgentTeamTask | undefined
  createTask: (input: CreateTaskInput) => AgentTeamTask
  /**
   * Kick off the run.
   *
   * `goal` is the issue, stated as the Squad's objective. The previous
   * `agentTeamManager.start` took none, so the lead planned against whatever
   * objective the Squad had been configured with while the issue arrived as
   * one more task in the list — the run row then had nothing to call itself.
   */
  startTeam: (teamId: string, origin: IssueRunOrigin, goal?: string) => Promise<void>
  abortTeam: (teamId: string, reason: string) => void
  /** Durable-v2 artifact readers (best-effort; may return nothing for legacy runs). */
  collectArtifacts: (run: IssueRun) => Promise<IssueRunArtifact[]>
  createRun: typeof createIssueRun
  now: () => number
  onStartError?: (error: unknown) => void
}

async function defaultGetTeamStore() {
  const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
  return useAgentTeamStore
}

/**
 * Store + manager access is lazy: `agent-team.ts` drags the whole team runtime
 * chain in, and the tracker must not pay for that at import time (same
 * rationale as `lib/scheduler/executors/team-executor.ts`).
 */
export function createDefaultAgentTeamRunAdapterDeps(): AgentTeamRunAdapterDeps {
  return {
    getTeam: (teamId) => {
      // Synchronous read via the already-loaded store when available; the
      // lazy path below is only for the first touch in a cold module graph.
      const store = loadedStore
      return store ? store.getState().teams[teamId] : undefined
    },
    getTask: (taskId) => loadedStore?.getState().tasks[taskId],
    createTask: (input) => {
      if (!loadedStore) throw new Error("agent team store not loaded")
      return loadedStore.getState().createTask(input)
    },
    startTeam: async (teamId, origin, goal) => {
      // `startSquadRun` is the one funnel (ADR-0140). Going straight to
      // `agentTeamManager.start` skipped the run-id convention, the
      // `projectId` stamp and the execution row itself, so an issue-dispatched
      // run was invisible in the cockpit unless the Squad was `durable-v2`.
      //
      // No `session`: an issue is not a conversation. The run is therefore
      // uncarded — no thread to project progress onto and no control callback
      // to match — which the run row states rather than implies.
      const { startSquadRun } = await import("@/lib/ai/agent/team/start-squad-run")
      const result = await startSquadRun({
        squadId: teamId,
        goal: goal ?? "",
        origin,
        triggeredFrom: { source: origin === "im" ? "im" : "ui" },
      })
      if (!result.started) {
        throw new Error(`squad run refused: ${result.reason ?? "unknown"}`)
      }
    },
    abortTeam: (teamId, reason) => {
      void import("@/lib/ai/agent/agent-team-runtime").then(({ abortTeam }) =>
        abortTeam(teamId, new Error(reason))
      )
    },
    collectArtifacts: collectDurableArtifacts,
    createRun: createIssueRun,
    now: Date.now,
  }
}

type AgentTeamStoreApi = Awaited<ReturnType<typeof defaultGetTeamStore>>
let loadedStore: AgentTeamStoreApi | null = null

/** Resolve the lazily-imported store once; `install.ts` awaits this at boot. */
export async function ensureAgentTeamStoreLoaded(): Promise<AgentTeamStoreApi> {
  if (!loadedStore) loadedStore = await defaultGetTeamStore()
  return loadedStore
}

/** Test-only. */
export function __setLoadedAgentTeamStoreForTesting(store: AgentTeamStoreApi | null): void {
  loadedStore = store
}

/**
 * Durable-v2 artifacts for the team run that served this issue run: the
 * newest run record started at/after the issue run, its delivery-node PRs and
 * the child run (branch / worktree) that executed the issue's task.
 */
export async function collectDurableArtifacts(run: IssueRun): Promise<IssueRunArtifact[]> {
  const artifacts: IssueRunArtifact[] = [
    { label: "Team workspace", href: agentTeamWorkspaceHref(run.targetId) },
  ]
  const taskId = run.targetRef?.taskId
  const runs = await listAgentTeamRuns(run.targetId)
  const record = runs
    .filter((candidate) => candidate.createdAt >= run.startedAt - 1_000)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  if (!record) return artifacts

  const graph = await getAgentTeamDeliveryGraph(record.id)
  if (graph) {
    const nodes = await listAgentTeamDeliveryNodes(graph.id)
    for (const node of nodes) {
      if (node.pullRequestUrl) {
        artifacts.push({
          label: node.pullRequestNumber ? `PR #${node.pullRequestNumber}` : node.title,
          href: node.pullRequestUrl,
        })
      }
    }
  }
  const children = await listAgentTeamChildRuns(record.id)
  for (const child of children) {
    if (taskId && child.taskId !== taskId) continue
    if (child.branch) {
      artifacts.push({
        label: `Branch ${child.branch}`,
        // `/squads?...&tab=worktrees` was a link to nowhere: `SQUAD_TABS` is
        // `squads | runs | board`, so `useSquadRouteState` dropped the value
        // and the console opened on its landing tab. ADR-0140 moved what a
        // finished run leaves behind onto the workspace surface —
        // `AgentBranchesSection` lives in `/workspace`'s Environments tab, and
        // `RunOperationsTab` sends a reader to the same place. That tab IS
        // addressable (`app/workspace/page.tsx` reads `?tab=`), which is what
        // the phone's Source Control screen already links to.
        href: AGENT_BRANCHES_HREF,
      })
    }
    if (child.sessionId) {
      artifacts.push({
        label: `Session (${child.teammateId})`,
        href: `/?session=${encodeURIComponent(child.sessionId)}`,
      })
    }
  }
  return artifacts
}

export function createAgentTeamRunAdapter(
  overrides: Partial<AgentTeamRunAdapterDeps> = {}
): IssueRunAdapter {
  const deps: AgentTeamRunAdapterDeps = { ...createDefaultAgentTeamRunAdapterDeps(), ...overrides }

  async function canRun(target: IssueRunTarget): Promise<IssueRunVerdict> {
    const assignee = target.issue.assignee
    if (!assignee || assignee.kind !== "team" || !assignee.id) {
      return { ok: false, reason: "assignee-kind-mismatch" }
    }
    const team = deps.getTeam(assignee.id)
    if (!team) return { ok: false, reason: "assignee-not-found", detail: assignee.id }
    if (BUSY_TEAM_STATUSES.has(team.status)) {
      return { ok: false, reason: "team-busy", detail: team.status }
    }
    return { ok: true }
  }

  return {
    id: AGENT_TEAM_RUN_ADAPTER_ID,
    kind: "agent-team",
    canRun,
    async start(target: IssueRunTarget, context: IssueRunStartContext): Promise<IssueRun> {
      const verdict = await canRun(target)
      if (!verdict.ok) throw new Error(`agent-team adapter refused: ${verdict.reason}`)
      const { issue, project } = target
      const teamId = issue.assignee!.id!
      const task = deps.createTask({
        teamId,
        title: `${issue.identifier}: ${issue.title}`,
        description: [
          issue.description ?? issue.title,
          project?.description ? `\n\nProject context: ${project.description}` : "",
        ].join(""),
        priority: issuePriorityToSubAgentPriority(issue.priority),
        tags: ["issue", issue.identifier],
        metadata: { issueId: issue.id, issueIdentifier: issue.identifier },
      })
      const run = await deps.createRun({
        issueId: issue.id,
        projectId: issue.projectId,
        adapterId: AGENT_TEAM_RUN_ADAPTER_ID,
        kind: "agent-team",
        targetId: teamId,
        targetRef: { taskId: task.id },
        by: context.by,
        status: "running",
        now: deps.now(),
      })
      // Resolves at terminal state — never awaited here. A start that throws
      // synchronously (team vanished between canRun and start) still surfaces.
      deps
        .startTeam(teamId, context.origin, `${issue.identifier}: ${issue.title}`)
        .catch((error) => {
          deps.onStartError?.(error)
        })
      return run
    },
    async poll(run: IssueRun): Promise<IssueRunPollResult> {
      const taskId = run.targetRef?.taskId
      const task = taskId ? deps.getTask(taskId) : undefined
      if (!task) return { status: "failed", error: "team task no longer exists" }
      switch (task.status) {
        case "completed":
          return {
            status: "succeeded",
            ...(task.result ? { summary: task.result.slice(0, 500) } : {}),
            artifacts: await deps.collectArtifacts(run),
          }
        case "failed":
          return {
            status: "failed",
            error: task.error ?? "team task failed",
            artifacts: await deps.collectArtifacts(run),
          }
        case "cancelled":
          return { status: "cancelled" }
        default: {
          // Not terminal. If the team itself has stopped, the task was never
          // picked up (or the run was aborted) — do not leave the issue
          // runtime-owned forever.
          const team = deps.getTeam(run.targetId)
          if (!team) return { status: "failed", error: "team no longer exists" }
          if (!BUSY_TEAM_STATUSES.has(team.status) && team.status !== "idle") {
            return {
              status: "failed",
              error: `team run ended (${team.status}) before the task ran`,
              artifacts: await deps.collectArtifacts(run),
            }
          }
          return null
        }
      }
    },
    async cancel(run: IssueRun): Promise<void> {
      deps.abortTeam(run.targetId, `issue run ${run.id} cancelled`)
    },
  }
}

/** `IssuePriority` → `SubAgentPriority`; `none` reads as `normal`. */
export function issuePriorityToSubAgentPriority(
  priority: IssueRunTarget["issue"]["priority"]
): NonNullable<CreateTaskInput["priority"]> {
  switch (priority) {
    case "urgent":
      return "critical"
    case "high":
      return "high"
    case "low":
      return "low"
    case "medium":
    case "none":
      return "normal"
  }
}
