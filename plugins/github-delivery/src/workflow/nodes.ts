/**
 * The 13 `action.github.*` workflow node executors.
 *
 * Each executor is a thin Octokit call wrapped in {@link guardedExecutor},
 * which handles repo resolution / policy / audit logging uniformly.
 *
 * Output shape conventions:
 *   - Successful API call: return an object with the API fields we care about.
 *   - Policy denied:       guardedExecutor returns `{ skipped: true, reason }`.
 *   - Hard failure:        throw; orchestrator records the error & retries.
 *
 * Registration model (post-ADR-0026 migration): the executor descriptors
 * collect into `GITHUB_NODE_DEFINITIONS` at module load via `defineNode`,
 * but they are NOT registered against the global node registry until the
 * plugin's `activate()` calls `registerGithubNodes()`. Deactivate calls
 * `unregisterGithubNodes()` so disabling the plugin actually removes the
 * node kinds from the editor, instead of leaking them across reloads as
 * the pre-migration import-time `registerNodeExecutor(...)` did.
 */

import {
  registerNodeExecutor,
  unregisterNodeExecutor,
  type NodeExecutorRegistration,
} from "@/lib/workflow/nodes/registry"
import type { GhAction } from "@/lib/github/types"
import { computeBump, parseCommitMessage, applyBump, renderChangelog } from "@/lib/github/changelog"
import { guardedExecutor, splitRepo } from "./shared"
import { runIssueLoop, type RunIssueLoopResult } from "./issue-loop"
import { runPRReviewAgent, type RunPRReviewAgentResult } from "./review-pr-inline"

/**
 * Collected executor descriptors. Populated by every `defineNode(...)`
 * call below at module-load time. Consumed exclusively by
 * `registerGithubNodes` / `unregisterGithubNodes`.
 */
const GITHUB_NODE_DEFINITIONS: NodeExecutorRegistration[] = []

function defineNode(reg: NodeExecutorRegistration): void {
  GITHUB_NODE_DEFINITIONS.push(reg)
}

/**
 * Idempotent — registering twice is a harmless no-op the registry
 * tolerates (the second call overwrites the first with an identical
 * descriptor). Returns the number of nodes registered for diagnostics.
 */
export function registerGithubNodes(): number {
  for (const reg of GITHUB_NODE_DEFINITIONS) {
    registerNodeExecutor(reg)
  }
  return GITHUB_NODE_DEFINITIONS.length
}

/**
 * Symmetric tear-down. Idempotent — `unregisterNodeExecutor` silently
 * no-ops when the kind isn't registered.
 */
export function unregisterGithubNodes(): void {
  for (const reg of GITHUB_NODE_DEFINITIONS) {
    unregisterNodeExecutor(reg.kind, reg.typeVersion)
  }
}

/**
 * Exposed for tests + the future ADR-0026 manifest bridge.
 */
export function getGithubNodeDefinitions(): readonly NodeExecutorRegistration[] {
  return GITHUB_NODE_DEFINITIONS
}

// ── Type definitions for params (mirrors what the inspector form will write) ──

type Common = { repoFullName: string; policyOverride?: Record<string, unknown> }

interface OpenPrParams extends Common {
  head: string
  base: string
  title: string
  body?: string
  draft?: boolean
}
interface ClosePrParams extends Common {
  prNumber: number
}
interface MergePrParams extends Common {
  prNumber: number
  mergeMethod?: "merge" | "squash" | "rebase"
  commitTitle?: string
  commitMessage?: string
}
interface ReviewPrParams extends Common {
  prNumber: number
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
  body: string
  comments?: Array<{ path: string; position: number; body: string }>
}
interface CommentPrParams extends Common {
  prNumber: number
  body: string
}
interface CommentIssueParams extends Common {
  issueNumber: number
  body: string
}
interface LabelIssueParams extends Common {
  issueNumber: number
  add?: string[]
  remove?: string[]
}
interface CloseIssueParams extends Common {
  issueNumber: number
  reason?: "completed" | "not_planned"
}
interface CreateReleaseParams extends Common {
  tag: string
  targetCommitish?: string
  name?: string
  body?: string
  draft?: boolean
  prerelease?: boolean
}
interface GenerateChangelogParams extends Common {
  /** Tag or SHA to diff from. */
  since: string
  /** Current version string the bump applies to (e.g. last published tag). */
  currentVersion?: string
}
interface PushTagParams extends Common {
  tag: string
  sha: string
}
interface RunIssueLoopParams extends Common {
  issueNumber: number
  /** Worktree backend; "local" by default. "e2b" stub-throws in M5. */
  worktreeMode?: "local" | "e2b"
  /** Branch name template, default `cognia/issue-{n}`. */
  branchTemplate?: string
}
interface ReviewPrInlineParams extends Common {
  prNumber: number
  provider: string
  model: string
  apiKey: string
  baseURL?: string
  maxFiles?: number
  focus?: string
}

// ── Helpers ────────────────────────────────────────────────────────────────

function policyOverrideOf<T extends Common>(params: T): Record<string, unknown> | undefined {
  return params.policyOverride
}

// ── openPr ────────────────────────────────────────────────────────────────

defineNode({
  kind: "action.github.openPr",
  typeVersion: 1,
  execute: guardedExecutor<OpenPrParams, { number: number; htmlUrl: string }>({
    repoFrom: (p) => p.repoFullName,
    policyOverride: policyOverrideOf,
    action: (p): GhAction => ({ kind: "push", repo: p.repoFullName, branch: p.head }),
    run: async ({ octokit, repoFullName, step }) => {
      const { owner, repo } = splitRepo(repoFullName)
      const resp = (await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        title: step.params.title,
        head: step.params.head,
        base: step.params.base,
        body: step.params.body,
        draft: step.params.draft,
      })) as { data: { number: number; html_url: string } }
      return { number: resp.data.number, htmlUrl: resp.data.html_url }
    },
  }),
})

// ── closePr ────────────────────────────────────────────────────────────────

defineNode({
  kind: "action.github.closePr",
  typeVersion: 1,
  execute: guardedExecutor<ClosePrParams, { number: number; state: string }>({
    repoFrom: (p) => p.repoFullName,
    policyOverride: policyOverrideOf,
    action: (p): GhAction => ({
      kind: "close",
      target: { repo: p.repoFullName, prNumber: p.prNumber },
    }),
    run: async ({ octokit, repoFullName, step }) => {
      const { owner, repo } = splitRepo(repoFullName)
      const resp = (await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: step.params.prNumber,
        state: "closed",
      })) as { data: { number: number; state: string } }
      return { number: resp.data.number, state: resp.data.state }
    },
  }),
})

// ── mergePr ────────────────────────────────────────────────────────────────

defineNode({
  kind: "action.github.mergePr",
  typeVersion: 1,
  execute: guardedExecutor<MergePrParams, { merged: boolean; sha: string }>({
    repoFrom: (p) => p.repoFullName,
    policyOverride: policyOverrideOf,
    action: (p): GhAction => ({
      kind: "merge",
      pr: { repo: p.repoFullName, prNumber: p.prNumber },
      mergeMethod: p.mergeMethod,
    }),
    run: async ({ octokit, repoFullName, step }) => {
      const { owner, repo } = splitRepo(repoFullName)
      const resp = (await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
        owner,
        repo,
        pull_number: step.params.prNumber,
        merge_method: step.params.mergeMethod ?? "merge",
        commit_title: step.params.commitTitle,
        commit_message: step.params.commitMessage,
      })) as { data: { merged: boolean; sha: string } }
      return { merged: resp.data.merged, sha: resp.data.sha }
    },
  }),
})

// ── reviewPr ──────────────────────────────────────────────────────────────

defineNode({
  kind: "action.github.reviewPr",
  typeVersion: 1,
  execute: guardedExecutor<ReviewPrParams, { id: number; state: string }>({
    repoFrom: (p) => p.repoFullName,
    policyOverride: policyOverrideOf,
    action: (p): GhAction => ({
      kind: "comment",
      pr: { repo: p.repoFullName, prNumber: p.prNumber },
      body: p.body,
    }),
    run: async ({ octokit, repoFullName, step }) => {
      const { owner, repo } = splitRepo(repoFullName)
      const resp = (await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        {
          owner,
          repo,
          pull_number: step.params.prNumber,
          event: step.params.event,
          body: step.params.body,
          comments: step.params.comments,
        }
      )) as { data: { id: number; state: string } }
      return { id: resp.data.id, state: resp.data.state }
    },
  }),
})

// ── commentPr ─────────────────────────────────────────────────────────────

defineNode({
  kind: "action.github.commentPr",
  typeVersion: 1,
  execute: guardedExecutor<CommentPrParams, { id: number; htmlUrl: string }>({
    repoFrom: (p) => p.repoFullName,
    policyOverride: policyOverrideOf,
    action: (p): GhAction => ({
      kind: "comment",
      pr: { repo: p.repoFullName, prNumber: p.prNumber },
      body: p.body,
    }),
    run: async ({ octokit, repoFullName, step }) => {
      const { owner, repo } = splitRepo(repoFullName)
      // PR comments use the issues comments endpoint (GitHub model: a PR is an Issue).
      const resp = (await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner,
          repo,
          issue_number: step.params.prNumber,
          body: step.params.body,
        }
      )) as { data: { id: number; html_url: string } }
      return { id: resp.data.id, htmlUrl: resp.data.html_url }
    },
  }),
})

// ── commentIssue ─────────────────────────────────────────────────────────

defineNode({
  kind: "action.github.commentIssue",
  typeVersion: 1,
  execute: guardedExecutor<CommentIssueParams, { id: number; htmlUrl: string }>({
    repoFrom: (p) => p.repoFullName,
    policyOverride: policyOverrideOf,
    action: (p): GhAction => ({
      kind: "comment",
      issue: { repo: p.repoFullName, issueNumber: p.issueNumber },
      body: p.body,
    }),
    run: async ({ octokit, repoFullName, step }) => {
      const { owner, repo } = splitRepo(repoFullName)
      const resp = (await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner,
          repo,
          issue_number: step.params.issueNumber,
          body: step.params.body,
        }
      )) as { data: { id: number; html_url: string } }
      return { id: resp.data.id, htmlUrl: resp.data.html_url }
    },
  }),
})

// ── labelIssue ────────────────────────────────────────────────────────────

defineNode({
  kind: "action.github.labelIssue",
  typeVersion: 1,
  execute: guardedExecutor<LabelIssueParams, { added: string[]; removed: string[] }>({
    repoFrom: (p) => p.repoFullName,
    policyOverride: policyOverrideOf,
    action: (p): GhAction => ({
      kind: "label",
      target: { repo: p.repoFullName, issueNumber: p.issueNumber },
      labels: [...(p.add ?? []), ...(p.remove ?? [])],
    }),
    run: async ({ octokit, repoFullName, step }) => {
      const { owner, repo } = splitRepo(repoFullName)
      const add = step.params.add ?? []
      const remove = step.params.remove ?? []
      if (add.length > 0) {
        await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
          owner,
          repo,
          issue_number: step.params.issueNumber,
          labels: add,
        })
      }
      for (const label of remove) {
        await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
          owner,
          repo,
          issue_number: step.params.issueNumber,
          name: label,
        })
      }
      return { added: add, removed: remove }
    },
  }),
})

// ── closeIssue ────────────────────────────────────────────────────────────

defineNode({
  kind: "action.github.closeIssue",
  typeVersion: 1,
  execute: guardedExecutor<CloseIssueParams, { number: number; state: string }>({
    repoFrom: (p) => p.repoFullName,
    policyOverride: policyOverrideOf,
    action: (p): GhAction => ({
      kind: "close",
      target: { repo: p.repoFullName, issueNumber: p.issueNumber },
    }),
    run: async ({ octokit, repoFullName, step }) => {
      const { owner, repo } = splitRepo(repoFullName)
      const resp = (await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
        owner,
        repo,
        issue_number: step.params.issueNumber,
        state: "closed",
        state_reason: step.params.reason,
      })) as { data: { number: number; state: string } }
      return { number: resp.data.number, state: resp.data.state }
    },
  }),
})

// ── createRelease ─────────────────────────────────────────────────────────

defineNode({
  kind: "action.github.createRelease",
  typeVersion: 1,
  execute: guardedExecutor<CreateReleaseParams, { id: number; htmlUrl: string; tag: string }>({
    repoFrom: (p) => p.repoFullName,
    policyOverride: policyOverrideOf,
    action: (p): GhAction => ({
      kind: "release",
      repo: p.repoFullName,
      tag: p.tag,
      draft: p.draft ?? true,
    }),
    run: async ({ octokit, repoFullName, step }) => {
      const { owner, repo } = splitRepo(repoFullName)
      const resp = (await octokit.request("POST /repos/{owner}/{repo}/releases", {
        owner,
        repo,
        tag_name: step.params.tag,
        target_commitish: step.params.targetCommitish,
        name: step.params.name,
        body: step.params.body,
        draft: step.params.draft ?? true,
        prerelease: step.params.prerelease ?? false,
      })) as { data: { id: number; html_url: string; tag_name: string } }
      return { id: resp.data.id, htmlUrl: resp.data.html_url, tag: resp.data.tag_name }
    },
  }),
})

// ── generateChangelog ─────────────────────────────────────────────────────

interface ChangelogOutput {
  bump: "major" | "minor" | "patch" | "none"
  nextVersion: string
  markdown: string
  commitCount: number
}

defineNode({
  kind: "action.github.generateChangelog",
  typeVersion: 1,
  execute: guardedExecutor<GenerateChangelogParams, ChangelogOutput>({
    repoFrom: (p) => p.repoFullName,
    action: () => null, // read-only — bypass policy
    run: async ({ octokit, repoFullName, step }) => {
      const { owner, repo } = splitRepo(repoFullName)
      // Use "compare commits" — endpoint emits a flat list of commits from
      // the comparison base to HEAD (default branch).
      const resp = (await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
        owner,
        repo,
        basehead: `${step.params.since}...HEAD`,
      })) as {
        data: {
          commits: Array<{
            sha: string
            commit: { message: string; author?: { name?: string; email?: string } }
          }>
        }
      }
      const parsed = resp.data.commits
        .map((c) =>
          parseCommitMessage(c.sha, c.commit.message, {
            authorName: c.commit.author?.name,
            authorEmail: c.commit.author?.email,
          })
        )
        .filter((p): p is NonNullable<typeof p> => p !== null)
      const bump = computeBump(parsed)
      const nextVersion = applyBump(step.params.currentVersion ?? "0.0.0", bump)
      const markdown = renderChangelog(parsed, {
        bump,
        nextVersion,
        repoFullName,
      })
      return { bump, nextVersion, markdown, commitCount: parsed.length }
    },
  }),
})

// ── pushTag ───────────────────────────────────────────────────────────────

defineNode({
  kind: "action.github.pushTag",
  typeVersion: 1,
  execute: guardedExecutor<PushTagParams, { tag: string; sha: string }>({
    repoFrom: (p) => p.repoFullName,
    policyOverride: policyOverrideOf,
    action: (p): GhAction => ({ kind: "push", repo: p.repoFullName, branch: `refs/tags/${p.tag}` }),
    run: async ({ octokit, repoFullName, step }) => {
      const { owner, repo } = splitRepo(repoFullName)
      await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
        owner,
        repo,
        ref: `refs/tags/${step.params.tag}`,
        sha: step.params.sha,
      })
      return { tag: step.params.tag, sha: step.params.sha }
    },
  }),
})

// ── runIssueLoop ──────────────────────────────────────────────────────────
//
// The Issue → AI worktree → PR loop. Fully wired: the execute delegates to
// `runIssueLoop` (./issue-loop), which clones the repo into the configured
// workspace backend, drives the agent, pushes the source branch, and opens the
// PR. The node layer here adds kind registration, param resolution, the
// push-action policy gate, and audit.

defineNode({
  kind: "action.github.runIssueLoop",
  typeVersion: 1,
  execute: guardedExecutor<RunIssueLoopParams, RunIssueLoopResult>({
    repoFrom: (p) => p.repoFullName,
    policyOverride: policyOverrideOf,
    action: (p): GhAction => ({
      kind: "push",
      repo: p.repoFullName,
      branch: (p.branchTemplate ?? "cognia/issue-{n}").replace("{n}", String(p.issueNumber)),
    }),
    describe: (p) => `Issue → PR loop for issue #${p.issueNumber} in ${p.repoFullName}`,
    run: async ({ step }) =>
      runIssueLoop({
        ...step.params,
        workflowRunId: step.runId,
        workflowStepId: step.stepId,
      }),
  }),
})

// ── reviewPrInline ────────────────────────────────────────────────────────
//
// Upgrade of the legacy ai.prompt + commentPr chain. Lets the LLM emit
// structured inline comments alongside an overall review body. Posts via
// Octokit's POST /pulls/{n}/reviews so reviewers see comments anchored to
// real diff lines.

defineNode({
  kind: "action.github.reviewPrInline",
  typeVersion: 1,
  execute: guardedExecutor<ReviewPrInlineParams, RunPRReviewAgentResult>({
    repoFrom: (p) => p.repoFullName,
    policyOverride: policyOverrideOf,
    action: (p): GhAction => ({
      kind: "comment",
      pr: { repo: p.repoFullName, prNumber: p.prNumber },
      body: "[inline review]",
    }),
    describe: (p) => `Inline review of PR #${p.prNumber} in ${p.repoFullName}`,
    run: async ({ octokit, step }) =>
      runPRReviewAgent(
        {
          repoFullName: step.params.repoFullName,
          prNumber: step.params.prNumber,
          provider: step.params.provider,
          model: step.params.model,
          apiKey: step.params.apiKey,
          baseURL: step.params.baseURL,
          maxFiles: step.params.maxFiles,
          focus: step.params.focus,
        },
        octokit
      ),
  }),
})
