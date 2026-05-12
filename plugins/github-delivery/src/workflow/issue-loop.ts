/**
 * runIssueLoop happy-path implementation.
 *
 * Pipeline:
 *   1. Resolve the issue via Octokit (title + body).
 *   2. Clone the repo into a local worktree using lib/github/workspace.
 *   3. Hand the worktree path + issue context to a registered AI driver
 *      (Claude Code by default — wired via {@link setIssueLoopDriver}).
 *   4. Commit + push the resulting changes.
 *   5. Open a PR with body referencing the source issue.
 *   6. Label the PR `cognia:opened-by-bot`.
 *
 * The AI driver is pluggable so this module can be unit-tested without a
 * real Claude Code subprocess. In production, the plugin entry sets a
 * driver backed by `lib/claude/agents/claude-code`.
 */

import type { Octokit } from "@octokit/core"
import { cloneToWorkspace, commitAndPush, type WorkspaceHandle } from "@/lib/github/workspace"
import type {
  GhAction,
  GhWorkOrder,
  WorkOrderStatus,
} from "@/lib/github/types"
import { requireGithubRuntime } from "./runtime"

/** Hard wall-clock cap (60 min) so a stuck driver doesn't run forever. */
const HARD_TIMEOUT_MS = 60 * 60_000

export interface IssueLoopDriver {
  /**
   * Run the AI against an issue + cloned worktree. The driver is responsible
   * for editing files in `workspacePath` and returning a summary string that
   * will be used as the PR body. Throwing aborts the loop.
   */
  run(opts: {
    workspacePath: string
    repoFullName: string
    issueNumber: number
    issueTitle: string
    issueBody: string
    signal: AbortSignal
  }): Promise<{ summary: string; durationMs: number }>
}

let _driver: IssueLoopDriver | null = null

export function setIssueLoopDriver(d: IssueLoopDriver | null): void {
  _driver = d
}

export function getIssueLoopDriver(): IssueLoopDriver | null {
  return _driver
}

export interface RunIssueLoopParams {
  repoFullName: string
  issueNumber: number
  worktreeMode?: "local" | "e2b"
  branchTemplate?: string
}

export interface RunIssueLoopResult {
  status: "pr_opened" | "skipped" | "failed"
  branch?: string
  prNumber?: number
  prUrl?: string
  durationMs?: number
  reason?: string
}

interface IssueResp {
  data: {
    title: string
    body: string | null
  }
}

interface PrResp {
  data: { number: number; html_url: string }
}

/**
 * The main entry. Returns a result describing how the loop terminated.
 *
 * Side effects:
 *   - Writes the work order through to the workOrders Dexie table at each
 *     phase transition (open → in_progress → pr_opened / failed).
 *   - Pushes a branch + opens a PR via Octokit.
 *   - Clones a fresh worktree directory.
 *
 * Test-only deps can be injected via {@link IssueLoopHooks} so the unit test
 * doesn't actually fork a process / hit GitHub.
 */
export interface IssueLoopHooks {
  cloneToWorkspace?: typeof cloneToWorkspace
  commitAndPush?: typeof commitAndPush
  /** Override Date.now for deterministic test output. */
  now?: () => number
  /** Override the AbortController for tests. */
  abortController?: AbortController
}

export async function runIssueLoop(
  params: RunIssueLoopParams,
  hooks: IssueLoopHooks = {}
): Promise<RunIssueLoopResult> {
  const rt = requireGithubRuntime()
  const driver = _driver
  if (!driver) {
    return {
      status: "failed",
      reason:
        "No issue-loop AI driver is registered. Connect Claude Code in Settings → Providers before running this node.",
    }
  }

  const cloner = hooks.cloneToWorkspace ?? cloneToWorkspace
  const pusher = hooks.commitAndPush ?? commitAndPush
  const now = hooks.now ?? Date.now
  const controller = hooks.abortController ?? new AbortController()

  const timeout = setTimeout(() => controller.abort("runIssueLoop: hard 60-min timeout"), HARD_TIMEOUT_MS)
  const start = now()
  const branch = (params.branchTemplate ?? "cognia/issue-{n}").replace(
    "{n}",
    String(params.issueNumber)
  )

  // Per-step work-order updates are best-effort; we don't fail the loop if
  // the row write fails. The runtime's recordAudit path already captures the
  // canonical history.
  await safeUpdateWorkOrder(rt, {
    repoFullName: params.repoFullName,
    issueNumber: params.issueNumber,
    status: "in_progress",
    branch,
    aiDriver: "claude-code",
  })

  let workspace: WorkspaceHandle | null = null
  try {
    // 1. Resolve octokit + repo.
    const octokit = await rt.getOctokit(params.repoFullName)
    const [owner, repo] = params.repoFullName.split("/")

    // 2. Fetch issue.
    const issue = (await octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      { owner, repo, issue_number: params.issueNumber }
    )) as IssueResp
    if (controller.signal.aborted) throw new Error("runIssueLoop aborted")

    // 3. Resolve token for clone (use the same octokit, but we need the raw
    //    token string for git clone via x-access-token URL). Tokens are
    //    rotated through the auth strategy.
    const auth = (await octokit.auth()) as { token: string }
    if (!auth?.token) throw new Error("runIssueLoop: could not resolve clone token")

    // 4. Clone.
    workspace = await cloner({
      repoFullName: params.repoFullName,
      branch: "main",
      token: auth.token,
      backend: params.worktreeMode ?? "local",
    })

    // 5. Drive the AI.
    const driverResult = await driver.run({
      workspacePath: workspace.path,
      repoFullName: params.repoFullName,
      issueNumber: params.issueNumber,
      issueTitle: issue.data.title,
      issueBody: issue.data.body ?? "",
      signal: controller.signal,
    })

    // 6. Commit + push to the issue branch.
    workspace.branch = branch
    await pusher({
      workspace,
      message: `cognia: address #${params.issueNumber}\n\n${driverResult.summary}`.slice(0, 4000),
    })

    // 7. Open PR.
    const pr = (await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      title: `cognia: ${issue.data.title}`.slice(0, 256),
      head: branch,
      base: "main",
      body:
        `Resolves #${params.issueNumber}.\n\n` +
        `Generated by cognia GitHub Delivery. Driver: claude-code.\n\n` +
        `## Summary from the AI\n\n${driverResult.summary}`,
    })) as PrResp

    // 8. Tag the PR.
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
      {
        owner,
        repo,
        issue_number: pr.data.number,
        labels: ["cognia:opened-by-bot"],
      }
    )

    await safeUpdateWorkOrder(rt, {
      repoFullName: params.repoFullName,
      issueNumber: params.issueNumber,
      status: "pr_opened",
      branch,
      prNumber: pr.data.number,
      aiDriver: "claude-code",
    })

    return {
      status: "pr_opened",
      branch,
      prNumber: pr.data.number,
      prUrl: pr.data.html_url,
      durationMs: now() - start,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await safeUpdateWorkOrder(rt, {
      repoFullName: params.repoFullName,
      issueNumber: params.issueNumber,
      status: "failed",
      branch,
      aiDriver: "claude-code",
      lastError: reason,
    })
    return { status: "failed", reason, branch, durationMs: now() - start }
  } finally {
    clearTimeout(timeout)
  }
}

async function safeUpdateWorkOrder(
  rt: ReturnType<typeof requireGithubRuntime>,
  fields: Partial<GhWorkOrder> & {
    repoFullName: string
    issueNumber: number
    status: WorkOrderStatus
  }
): Promise<void> {
  try {
    await rt.upsertWorkOrder(fields)
  } catch (err) {
    // Swallow — the loop's main path must not depend on Dexie writes. The
    // audit table is the canonical history; workOrders is a UX convenience.
    // eslint-disable-next-line no-console
    console.error("safeUpdateWorkOrder failed:", err)
  }
}

/**
 * Test-only export for inspecting the action shape that downstream audit
 * would see for an issue-loop call. Reused by the nodes.ts executor so the
 * audit row stays consistent.
 */
export function describeIssueLoopAction(params: RunIssueLoopParams): GhAction {
  const branch = (params.branchTemplate ?? "cognia/issue-{n}").replace(
    "{n}",
    String(params.issueNumber)
  )
  return { kind: "push", repo: params.repoFullName, branch }
}
