/**
 * GitHub issue loop — optional run mode for a GitHub-linked issue.
 *
 * When the delivery container is bound to a GitHub repository AND the issue is
 * linked to a GitHub issue (`Issue.githubRef`), the existing
 * `github-delivery` integration action `runIssueLoop` (fetch → clone →
 * executeAgent → push → open PR, checkpointed and resumable —
 * `lib/integrations/github-issue-loop.ts`) can run the issue end to end. This
 * adapter never calls the loop directly: it enqueues the integration action
 * through `executeIntegrationAction`, exactly like `lib/issues/github-writeback.ts`,
 * so the run inherits the plugin's approval gate, PII gate, audit trail and
 * retry policy. `runIssueLoop` is `risk: "write"` with a required idempotency
 * key and a 30-minute timeout; the Run dialog is the confirmation, so the job
 * is released with `approval: "user-confirmed"`.
 *
 * Desktop-only: the loop needs a real clone (`resolveIntegrationActionAvailability`).
 */

import type { IssueProject, IssueRun, IssueRunArtifact } from "@/types/issues"
import type { IntegrationAccount, IntegrationActionJob } from "@/types/plugin/plugin-integration"
import { createIssueRun } from "@/lib/db/issue-runs"
import { getIntegrationActionJob } from "@/lib/db/integrations"
import {
  approveIntegrationActionJob,
  cancelIntegrationActionJob,
  executeIntegrationAction,
  resolveIntegrationActionAvailability,
} from "@/lib/integrations/action-runner"
import {
  GITHUB_DELIVERY_PLUGIN_ID,
  GITHUB_INTEGRATION_ID,
  resolveGithubWritebackAccount,
} from "@/lib/issues/github-writeback"
import type {
  IssueRunAdapter,
  IssueRunPollResult,
  IssueRunStartContext,
  IssueRunTarget,
  IssueRunVerdict,
} from "./types"

export const GITHUB_LOOP_RUN_ADAPTER_ID = "github-loop"

/** Head branch the loop pushes: `issue/<identifier>` lower-cased. */
export function githubLoopHeadBranch(identifier: string): string {
  return `issue/${identifier.toLowerCase()}`
}

/** Option key the Run dialog uses for the base branch. */
export const GITHUB_LOOP_BASE_OPTION = "base"
export const DEFAULT_GITHUB_LOOP_BASE = "main"

/**
 * Option key for the branch this issue's work should stack on.
 *
 * A stacked pull request is nothing more than one whose base is the previous
 * one's head, so this and `base` are the same field seen from two angles —
 * setting `stackOn` sets the base. They are separate options because the
 * *decision* is different: a base branch is where work lands, and a stack is
 * what it depends on.
 */
export const GITHUB_LOOP_STACK_ON_OPTION = "stackOn"

/** A branch an earlier issue run pushed, offered as somewhere to stack on. */
export interface GithubLoopStackCandidate {
  issueId: string
  branch: string
  repoFullName: string
  /** When the run that pushed it finished; newest is offered first. */
  at: number
}

/**
 * Branches from this repository that another issue's run has already pushed.
 *
 * Only succeeded runs. The loop pushes its branch on the way to opening the
 * pull request, so a `running` run may not have pushed yet and a `failed` one
 * may never have — and a pull request based on a branch the remote does not
 * have is rejected by GitHub with an error about the base ref. Offering a
 * choice that cannot work is worse than offering fewer.
 */
export function stackCandidatesFrom(
  runs: readonly IssueRun[],
  self: { issueId: string; repoFullName: string }
): GithubLoopStackCandidate[] {
  const byBranch = new Map<string, GithubLoopStackCandidate>()
  for (const run of runs) {
    if (run.kind !== "github-loop" || run.status !== "succeeded") continue
    if (run.issueId === self.issueId) continue
    const branch = run.targetRef?.head
    const repoFullName = run.targetRef?.repoFullName
    if (!branch || repoFullName !== self.repoFullName) continue
    const at = run.endedAt ?? run.updatedAt ?? run.startedAt
    const existing = byBranch.get(branch)
    if (!existing || at > existing.at) {
      byBranch.set(branch, { issueId: run.issueId, branch, repoFullName, at })
    }
  }
  return [...byBranch.values()].sort(
    (left, right) => right.at - left.at || left.branch.localeCompare(right.branch)
  )
}

/**
 * A local checkout of the issue project's repository, when it references one.
 *
 * The tracker never mounts a directory itself (ADR-0132): a `workspace-root`
 * resource is a reference to a root already mounted on the owning workspace,
 * so resolving it means looking that id up rather than trusting a path.
 * Absent when the container only knows the repository by name — the loop
 * clones into its own temporary workspace either way, so this is what makes
 * a stack visible in the user's own repository afterwards, not what makes the
 * run work.
 */
export function issueProjectLocalRoot(
  project: IssueProject | undefined,
  workspace: { roots?: Array<{ id: string; path: string }> } | undefined
): string | undefined {
  if (!project || !workspace?.roots) return undefined
  for (const resource of project.resources) {
    if (resource.kind !== "workspace-root") continue
    const root = workspace.roots.find((candidate) => candidate.id === resource.rootId)
    const path = root?.path?.trim()
    if (path) return path
  }
  return undefined
}

export interface GithubLoopRunAdapterDeps {
  isAvailable: () => boolean
  resolveAccount: () => Promise<IntegrationAccount | null>
  execute: typeof executeIntegrationAction
  approve: typeof approveIntegrationActionJob
  cancelJob: (jobId: string) => Promise<unknown>
  getJob: (jobId: string) => Promise<IntegrationActionJob | undefined>
  createRun: typeof createIssueRun
  now: () => number
  /**
   * Record the parent pointer in the user's own checkout, when the container
   * references one. Best effort by design — see `recordLocalParent`.
   */
  recordParent: (repoPath: string, branch: string, parent: string) => Promise<void>
  /** The workspace the issue belongs to, for resolving a `workspace-root`. */
  loadWorkspace: (
    projectId: string
  ) => Promise<{ roots?: Array<{ id: string; path: string }> } | undefined>
}

function defaultDeps(): GithubLoopRunAdapterDeps {
  return {
    isAvailable: () =>
      resolveIntegrationActionAvailability(
        GITHUB_DELIVERY_PLUGIN_ID,
        GITHUB_INTEGRATION_ID,
        "runIssueLoop"
      ).available,
    resolveAccount: resolveGithubWritebackAccount,
    execute: executeIntegrationAction,
    approve: approveIntegrationActionJob,
    cancelJob: cancelIntegrationActionJob,
    getJob: getIntegrationActionJob,
    createRun: createIssueRun,
    now: Date.now,
    recordParent: async (repoPath, branch, parent) => {
      const { gitStackSetParent } = await import("@/lib/git/commands")
      await gitStackSetParent(repoPath, branch, parent)
    },
    loadWorkspace: async (projectId) => {
      const { getDb } = await import("@/lib/db/schema")
      return getDb().projects.get(projectId)
    },
  }
}

/** The bound repository, if the container is bound to the issue's linked repo. */
export function boundRepoFor(target: IssueRunTarget): string | undefined {
  const ref = target.issue.githubRef
  if (!ref) return undefined
  const bound = target.project?.resources.some(
    (resource) => resource.kind === "github-repo" && resource.repoFullName === ref.repoFullName
  )
  return bound ? ref.repoFullName : undefined
}

/** Artifacts a finished loop job reports (`pullRequestUrl` / `branch`). */
export function githubLoopArtifacts(output: unknown): IssueRunArtifact[] {
  if (!output || typeof output !== "object") return []
  const record = output as Record<string, unknown>
  const artifacts: IssueRunArtifact[] = []
  if (typeof record.pullRequestUrl === "string") {
    const number =
      typeof record.pullRequestNumber === "number" ? `#${record.pullRequestNumber}` : ""
    artifacts.push({ label: `Pull request ${number}`.trim(), href: record.pullRequestUrl })
  }
  return artifacts
}

export function createGithubLoopRunAdapter(
  overrides: Partial<GithubLoopRunAdapterDeps> = {}
): IssueRunAdapter {
  const deps: GithubLoopRunAdapterDeps = { ...defaultDeps(), ...overrides }

  async function canRun(target: IssueRunTarget): Promise<IssueRunVerdict> {
    if (!target.issue.githubRef) return { ok: false, reason: "no-github-ref" }
    if (!boundRepoFor(target)) {
      return { ok: false, reason: "no-github-repo", detail: target.issue.githubRef.repoFullName }
    }
    if (!deps.isAvailable()) return { ok: false, reason: "desktop-only" }
    if (!(await deps.resolveAccount())) return { ok: false, reason: "no-github-account" }
    return { ok: true }
  }

  return {
    id: GITHUB_LOOP_RUN_ADAPTER_ID,
    kind: "github-loop",
    canRun,
    async start(target: IssueRunTarget, context: IssueRunStartContext): Promise<IssueRun> {
      const verdict = await canRun(target)
      if (!verdict.ok) throw new Error(`github-loop adapter refused: ${verdict.reason}`)
      const account = (await deps.resolveAccount())!
      const { issue } = target
      const ref = issue.githubRef!
      const head = githubLoopHeadBranch(issue.identifier)
      const stackOnOption = context.options?.[GITHUB_LOOP_STACK_ON_OPTION]
      const stackOn =
        typeof stackOnOption === "string" && stackOnOption.trim() ? stackOnOption.trim() : undefined
      if (stackOn === head) {
        throw new Error(`github-loop adapter refused: cannot stack ${head} on itself`)
      }
      const baseOption = context.options?.[GITHUB_LOOP_BASE_OPTION]
      // Stacking IS a base. When both arrive the stack wins, because a pull
      // request has exactly one base and honouring the other silently would
      // produce a flat pull request the user believes is stacked.
      const base =
        stackOn ??
        (typeof baseOption === "string" && baseOption.trim()
          ? baseOption.trim()
          : DEFAULT_GITHUB_LOOP_BASE)
      const now = deps.now()

      let job = await deps.execute(GITHUB_DELIVERY_PLUGIN_ID, {
        integrationId: GITHUB_INTEGRATION_ID,
        accountId: account.id,
        actionId: "runIssueLoop",
        input: {
          repoFullName: ref.repoFullName,
          issueNumber: ref.number,
          head,
          base,
          title: `${issue.identifier}: ${issue.title}`,
          ...(issue.description ? { body: issue.description } : {}),
        },
        source: "manual",
        idempotencyKey: `issue-run:${issue.id}:${now}`,
      })
      // The Run dialog IS the confirmation; release the write-tier job.
      if (job.status === "awaiting_approval") job = await deps.approve(job.id)

      if (stackOn) await recordLocalParent(deps, target, head, stackOn)

      return deps.createRun({
        issueId: issue.id,
        projectId: issue.projectId,
        adapterId: GITHUB_LOOP_RUN_ADAPTER_ID,
        kind: "github-loop",
        targetId: job.id,
        targetRef: {
          repoFullName: ref.repoFullName,
          head,
          base,
          ...(stackOn ? { stackedOn: stackOn } : {}),
        },
        by: context.by,
        status: job.status === "running" ? "running" : "queued",
        now,
      })
    },
    async poll(run: IssueRun): Promise<IssueRunPollResult> {
      const job = await deps.getJob(run.targetId)
      if (!job) return { status: "failed", error: "integration job no longer exists" }
      switch (job.status) {
        case "succeeded":
          return { status: "succeeded", artifacts: githubLoopArtifacts(job.output) }
        case "failed":
        case "deadlettered":
          return { status: "failed", error: job.error ?? `job ${job.status}` }
        case "cancelled":
          return { status: "cancelled" }
        default:
          return null
      }
    },
    async cancel(run: IssueRun): Promise<void> {
      await deps.cancelJob(run.targetId)
    },
  }
}

/**
 * Write the parent pointer into the user's own repository.
 *
 * The loop clones into its own temporary workspace, so nothing it does is
 * visible in the checkout on this machine. Without this, an issue chain would
 * be a stack on GitHub and three unrelated branches in the Stacks panel.
 *
 * Best effort, and deliberately so: the pull request has already been opened
 * by this point, and the stack is real whether or not a local checkout learns
 * about it. Failing the run here would report a successful dispatch as an
 * error over a bookkeeping detail — so the miss is swallowed, and the panel's
 * "record parent" action remains the way to fix it by hand.
 */
async function recordLocalParent(
  deps: GithubLoopRunAdapterDeps,
  target: IssueRunTarget,
  head: string,
  parent: string
): Promise<void> {
  try {
    const workspace = await deps.loadWorkspace(target.issue.projectId)
    const repoPath = issueProjectLocalRoot(target.project, workspace)
    if (!repoPath) return
    await deps.recordParent(repoPath, head, parent)
  } catch {
    // See above: bookkeeping, not the run.
  }
}
