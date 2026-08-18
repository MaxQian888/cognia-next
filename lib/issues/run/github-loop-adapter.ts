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

import type { IssueRun, IssueRunArtifact } from "@/types/issues"
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

export interface GithubLoopRunAdapterDeps {
  isAvailable: () => boolean
  resolveAccount: () => Promise<IntegrationAccount | null>
  execute: typeof executeIntegrationAction
  approve: typeof approveIntegrationActionJob
  cancelJob: (jobId: string) => Promise<unknown>
  getJob: (jobId: string) => Promise<IntegrationActionJob | undefined>
  createRun: typeof createIssueRun
  now: () => number
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
      const baseOption = context.options?.[GITHUB_LOOP_BASE_OPTION]
      const base =
        typeof baseOption === "string" && baseOption.trim()
          ? baseOption.trim()
          : DEFAULT_GITHUB_LOOP_BASE
      const head = githubLoopHeadBranch(issue.identifier)
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

      return deps.createRun({
        issueId: issue.id,
        projectId: issue.projectId,
        adapterId: GITHUB_LOOP_RUN_ADAPTER_ID,
        kind: "github-loop",
        targetId: job.id,
        targetRef: { repoFullName: ref.repoFullName, head, base },
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
