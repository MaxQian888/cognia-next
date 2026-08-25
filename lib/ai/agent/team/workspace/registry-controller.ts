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
}

export type AgentTeamWorkspaceReconcileMode = "manual" | "merge-all" | "select" | "pipeline"
export type AgentTeamWorkspaceSelectStrategy = "manual" | "first-success" | "judge"

export interface AgentTeamWorkspaceReconcileResult {
  mode: AgentTeamWorkspaceReconcileMode
  branches: string[]
  handles: PromotionWorkspaceHandle[]
  winnerKey?: string
  resultBranch?: string
  summary: string
}

interface DispatchCandidate {
  bundleTurnId: string
  bundleId: string
  workspaces: Array<{ workspaceId: string; logicalRootId: string }>
  key: string
  taskId: string
  teammateName: string
  executionRoot: string
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
    })
    return lease
  }

  recordDispatchResult(bundleTurnId: string, result: { ok: boolean; output?: string }): void {
    const candidate = this.candidates.get(bundleTurnId)
    if (!candidate) return
    candidate.ok = result.ok
    candidate.output = result.output
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
  }): Promise<AgentTeamWorkspaceReconcileResult> {
    if (options.mode === "merge-all") {
      throw new Error(
        "Agent Team merge-all requires a host-side atomic Registry promotion transaction; client-side git merge is intentionally disabled"
      )
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
    for (const { candidate, workspace } of unique) {
      const branch = `agent/${sanitizePromotionSegment(this.runId)}/${sanitizePromotionSegment(candidate.teammateName)}/${sanitizePromotionSegment(candidate.taskId)}`
      const record = await this.createBranch(workspace.workspaceId, branch)
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
}
