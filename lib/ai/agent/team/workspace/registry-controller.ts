import {
  acquireWorkspaceBundle,
  createWorkspaceBranch,
  runIdForTurn,
  taskIdForMessage,
} from "@/lib/task-workspace/client"
import {
  openWorkspaceBundleTurnLease,
  type WorkspaceBundleTurnLease,
} from "@/lib/task-workspace/run-lease"
import type {
  AcquireWorkspaceBundle,
  BeginTaskWorkspaceTurn,
  WorkspaceBaseSpec,
  WorkspaceBundle,
  WorkspaceProvisioning,
} from "@/lib/task-workspace/types"
import { provisioningForWorkspaceRoot } from "@/lib/task-workspace/workspace-provisioning"
import {
  integrateTeamRun,
  type AgentTeamIntegrationConfig,
  type AgentTeamIntegrationDeps,
  type AgentTeamIntegrationResult,
  type TeamIntegrationCandidate,
} from "./integrate-team-run"
import { sanitizePromotionSegment, type PromotionWorkspaceHandle } from "./promotion"

export interface AgentTeamWorkspaceRoot {
  logicalRootId: string
  sourceRoot: string
}

export interface OpenAgentTeamWorkspaceDispatch {
  taskId: string
  teammateId: string
  teammateName?: string
  repositoryId: string
  workspaceKey?: string
  traceId?: string
  traceSpanId?: string
}

type AcquireBundle = (input: AcquireWorkspaceBundle) => Promise<WorkspaceBundle>
type CreateBranch = typeof createWorkspaceBranch
type ResolveProvisioning = (sourceRoot: string) => Promise<WorkspaceProvisioning | undefined>
type OpenTurn = (
  bundle: Pick<WorkspaceBundle, "bundleId" | "leases">,
  primaryLogicalRootId: string,
  input: BeginTaskWorkspaceTurn
) => Promise<WorkspaceBundleTurnLease | null>

export interface AgentTeamRegistryWorkspaceControllerOptions {
  runId: string
  base: WorkspaceBaseSpec
  roots: AgentTeamWorkspaceRoot[]
  acquireBundle?: AcquireBundle
  openTurn?: OpenTurn
  createBranch?: CreateBranch
  /** Test seam; production reads the approved declaration + local consent. */
  resolveProvisioning?: ResolveProvisioning
  /**
   * Removes a branch `reconcile` created, when a later branch in the same
   * reconcile fails. Without it a partial reconcile leaves stray branches.
   */
  deleteBranch?: DeleteBranch
}

export type AgentTeamWorkspaceReconcileMode = "manual" | "merge-all" | "select" | "pipeline"
export type AgentTeamWorkspaceSelectStrategy = "manual" | "first-success" | "judge"

export interface AgentTeamWorkspaceReconcileResult {
  mode: AgentTeamWorkspaceReconcileMode
  branches: string[]
  handles: PromotionWorkspaceHandle[]
  winnerKey?: string
  resultBranch?: string
  /** `merge-all`: what the integration queue did, per repository (ADR-0227). */
  integration?: AgentTeamIntegrationResult
  summary: string
}

/** What `merge-all` needs: the queue's ports, the run's policy, and the task graph. */
export interface AgentTeamMergeAllOptions {
  config: AgentTeamIntegrationConfig
  deps: AgentTeamIntegrationDeps
  /** taskId → the taskIds it depends on, from the run's task list. */
  dependencies: Record<string, string[]>
}

type DeleteBranch = (workspaceId: string, branch: string) => Promise<void>

interface DispatchCandidate {
  bundleTurnId: string
  bundleId: string
  workspaces: Array<{ workspaceId: string; logicalRootId: string }>
  key: string
  taskId: string
  teammateName: string
  executionRoot: string
  /** The source checkout the dispatch's primary root was cut from. */
  sourceRoot: string
  ok?: boolean
  output?: string
}

/**
 * Run-scoped adapter from Agent Team dispatch identity to Registry Bundles.
 *
 * Each independent dispatch receives its own detached managed environment.
 * Pipeline stages opt into reuse with `workspaceKey`. The Registry remains the
 * lifecycle and ownership authority; this controller only caches acquisition
 * within one live team run and opens a tracked Bundle Turn for each stage.
 */
export class AgentTeamRegistryWorkspaceController {
  private readonly runId: string
  private readonly base: WorkspaceBaseSpec
  private readonly roots: AgentTeamWorkspaceRoot[]
  private readonly rootsById: Map<string, AgentTeamWorkspaceRoot>
  private readonly acquireBundle: AcquireBundle
  private readonly openTurn: OpenTurn
  private readonly createBranch: CreateBranch
  private readonly resolveProvisioning: ResolveProvisioning
  private readonly deleteBranch: DeleteBranch | undefined
  private readonly bundles = new Map<string, Promise<WorkspaceBundle>>()
  private readonly attempts = new Map<string, number>()
  private readonly candidates = new Map<string, DispatchCandidate>()

  constructor(options: AgentTeamRegistryWorkspaceControllerOptions) {
    if (options.roots.length === 0) {
      throw new Error("Agent Team Registry isolation requires at least one writable root")
    }
    this.runId = options.runId
    this.base = options.base
    this.roots = [...options.roots]
    this.rootsById = new Map()
    for (const root of this.roots) {
      if (this.rootsById.has(root.logicalRootId)) {
        throw new Error(`Duplicate Agent Team repository id: ${root.logicalRootId}`)
      }
      this.rootsById.set(root.logicalRootId, root)
    }
    this.acquireBundle = options.acquireBundle ?? acquireWorkspaceBundle
    this.openTurn = options.openTurn ?? openWorkspaceBundleTurnLease
    this.createBranch = options.createBranch ?? createWorkspaceBranch
    this.resolveProvisioning = options.resolveProvisioning ?? provisioningForWorkspaceRoot
    this.deleteBranch = options.deleteBranch
  }

  async openDispatch(input: OpenAgentTeamWorkspaceDispatch): Promise<WorkspaceBundleTurnLease> {
    const primary = this.rootsById.get(input.repositoryId)
    if (!primary) {
      throw new Error(
        `Agent Team repository "${input.repositoryId}" is not a writable Registry root`
      )
    }

    const allocationKey = `${input.repositoryId}:${input.workspaceKey ?? input.taskId}`
    let bundlePromise = this.bundles.get(allocationKey)
    if (!bundlePromise) {
      // A team fanning five tasks out cuts five worktrees, and each one starts
      // with no `node_modules`. Asking for the workspace's provisioning here is
      // what turns five cold installs into five links — the chat path has had
      // it since the declaration landed; this one had not.
      bundlePromise = this.resolveProvisioning(primary.sourceRoot)
        .catch(() => undefined)
        .then((provisioning) =>
          this.acquireBundle({
            ownerType: "team",
            ownerRef: this.runId,
            environmentKind: "managed",
            base: this.base,
            roots: this.roots.map((root) => ({
              logicalRootId: root.logicalRootId,
              role: root.logicalRootId === primary.logicalRootId ? "primary" : "additional",
              sourceRoot: root.sourceRoot,
            })),
            ...(provisioning ? { provisioning } : {}),
          })
        )
      this.bundles.set(allocationKey, bundlePromise)
      bundlePromise.catch(() => {
        if (this.bundles.get(allocationKey) === bundlePromise) this.bundles.delete(allocationKey)
      })
    }

    const bundle = await bundlePromise
    const attemptKey = `${allocationKey}:${input.teammateId}:${input.taskId}`
    const attempt = (this.attempts.get(attemptKey) ?? 0) + 1
    this.attempts.set(attemptKey, attempt)
    const dispatchRunId = runIdForTurn(
      `${this.runId}:${input.teammateId}:${input.taskId}:${input.workspaceKey ?? "dispatch"}`,
      attempt
    )
    const lease = await this.openTurn(bundle, primary.logicalRootId, {
      taskId: taskIdForMessage(`team:${this.runId}`),
      sessionId: this.runId,
      runId: dispatchRunId,
      executionRunId: this.runId,
      turnId: dispatchRunId,
      attemptId: `a${attempt}`,
      surface: "team",
      agentId: input.teammateId,
      agentKind: "agent-team",
      workspaceRoot: primary.sourceRoot,
      ...(input.workspaceKey ? { workspaceKey: input.workspaceKey } : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
      ...(input.traceSpanId ? { traceSpanId: input.traceSpanId } : {}),
    })
    if (!lease) {
      throw new Error("Registry did not return a Bundle Turn execution root for Agent Team")
    }
    const primaryRun = lease.runs.find((run) => run.logicalRootIds.includes(primary.logicalRootId))
    if (!primaryRun) {
      await lease.abort().catch(() => undefined)
      throw new Error("Registry Bundle Turn omitted the primary Agent Team workspace")
    }
    const workspaces = lease.runs.map((run) => ({
      workspaceId: run.workspaceId,
      logicalRootId: run.logicalRootIds[0] ?? primary.logicalRootId,
    }))
    this.candidates.set(lease.bundleTurnId, {
      bundleTurnId: lease.bundleTurnId,
      bundleId: lease.bundleId,
      workspaces,
      key: allocationKey,
      taskId: input.taskId,
      teammateName: input.teammateName ?? input.teammateId,
      executionRoot: lease.primaryAlias,
      sourceRoot: primary.sourceRoot,
    })
    return lease
  }

  recordDispatchResult(bundleTurnId: string, result: { ok: boolean; output?: string }): void {
    const candidate = this.candidates.get(bundleTurnId)
    if (!candidate) return
    candidate.ok = result.ok
    candidate.output = result.output
  }

  /** The source checkout a task's latest dispatch forked from (its review base lives there). */
  getDispatchSourceRoot(taskId: string): string | undefined {
    return [...this.candidates.values()].reverse().find((candidate) => candidate.taskId === taskId)
      ?.sourceRoot
  }

  getDispatchExecutionRoot(taskId: string): string | undefined {
    return [...this.candidates.values()].reverse().find((candidate) => candidate.taskId === taskId)
      ?.executionRoot
  }

  async reconcile(options: {
    mode: AgentTeamWorkspaceReconcileMode
    selectStrategy?: AgentTeamWorkspaceSelectStrategy
    judge?: (
      candidates: Array<{ key: string; ok: boolean; output?: string }>
    ) => Promise<string | null>
    /** Required for `merge-all`; without it the mode fails closed. */
    mergeAll?: AgentTeamMergeAllOptions
  }): Promise<AgentTeamWorkspaceReconcileResult> {
    if (options.mode === "merge-all") {
      if (!options.mergeAll) {
        throw new Error(
          "Agent Team merge-all needs the integration queue (ADR-0227); client-side git merge is intentionally disabled"
        )
      }
      return this.mergeAll(options.mergeAll)
    }
    const all = [...this.candidates.values()]
    let selected = all
    let winnerKey: string | undefined
    if (options.mode === "select" && options.selectStrategy !== "manual") {
      if (options.selectStrategy === "judge" && options.judge) {
        winnerKey =
          (await options.judge(
            all.map(({ key, ok, output }) => ({
              key,
              ok: ok === true,
              ...(output ? { output } : {}),
            }))
          )) ?? undefined
      }
      const winner =
        all.find((candidate) => candidate.key === winnerKey) ??
        all.find((candidate) => candidate.ok === true)
      selected = winner ? [winner] : []
      winnerKey = winner?.key
    }
    const uniqueByWorkspace = new Map<
      string,
      { candidate: DispatchCandidate; workspace: DispatchCandidate["workspaces"][number] }
    >()
    for (const candidate of selected) {
      for (const workspace of candidate.workspaces) {
        uniqueByWorkspace.set(workspace.workspaceId, { candidate, workspace })
      }
    }
    const unique = [...uniqueByWorkspace.values()]
    const handles: PromotionWorkspaceHandle[] = []
    const created: Array<{ workspaceId: string; branch: string }> = []
    try {
      for (const { candidate, workspace } of unique) {
        const branch = `agent/${sanitizePromotionSegment(this.runId)}/${sanitizePromotionSegment(candidate.teammateName)}/${sanitizePromotionSegment(candidate.taskId)}`
        const record = await this.createBranch(workspace.workspaceId, branch)
        created.push({ workspaceId: workspace.workspaceId, branch: record.branch ?? branch })
        handles.push({
          key: candidate.key,
          logicalRootId: workspace.logicalRootId,
          runId: this.runId,
          teammateName: candidate.teammateName,
          taskId: candidate.taskId,
          branch: record.branch ?? branch,
          path: record.executionRoot,
        })
      }
    } catch (error) {
      // All or nothing: a reconcile that stopped halfway must not leave the
      // branches it already made behind. Candidates are kept so it can be
      // retried.
      for (const { workspaceId, branch } of created.reverse()) {
        await this.deleteBranch?.(workspaceId, branch).catch(() => undefined)
      }
      throw error
    }
    this.candidates.clear()
    const branches = handles.map((handle) => handle.branch)
    return {
      mode: options.mode,
      branches,
      handles,
      ...(winnerKey ? { winnerKey } : {}),
      ...(branches.length === 1 ? { resultBranch: branches[0] } : {}),
      summary: `${branches.length} Registry environment(s) promoted for ${options.mode}`,
    }
  }

  /**
   * `merge-all` through the integration queue (ADR-0227 §5). Only successful
   * dispatches are candidates; each workspace once per repository.
   */
  private async mergeAll(
    options: AgentTeamMergeAllOptions
  ): Promise<AgentTeamWorkspaceReconcileResult> {
    const integrationCandidates: TeamIntegrationCandidate[] = []
    const seen = new Set<string>()
    for (const candidate of this.candidates.values()) {
      if (candidate.ok !== true) continue
      for (const workspace of candidate.workspaces) {
        if (seen.has(workspace.workspaceId)) continue
        seen.add(workspace.workspaceId)
        const root = this.rootsById.get(workspace.logicalRootId)
        if (!root) continue
        integrationCandidates.push({
          key: `${candidate.key}:${workspace.logicalRootId}`,
          taskId: candidate.taskId,
          teammateName: candidate.teammateName,
          logicalRootId: workspace.logicalRootId,
          sourceRoot: root.sourceRoot,
          workspaceId: workspace.workspaceId,
        })
      }
    }
    const integration = await integrateTeamRun(
      this.runId,
      integrationCandidates,
      options.dependencies,
      options.config,
      options.deps
    )
    this.candidates.clear()
    const branches = integration.roots.map((root) => root.targetRef).filter((ref) => ref.length > 0)
    const merged = integration.roots.reduce((sum, root) => sum + root.merged.length, 0)
    const waiting = integration.roots.reduce(
      (sum, root) => sum + root.awaitingApproval.length + root.changesRequested.length,
      0
    )
    return {
      mode: "merge-all",
      branches,
      handles: [],
      integration,
      ...(branches.length === 1 ? { resultBranch: branches[0] } : {}),
      summary: `${merged} changeset(s) integrated, ${waiting} awaiting review, across ${integration.roots.length} repository(ies)`,
    }
  }
}
