/**
 * Production resolvers for the Agent Team PR feedback deps — the desktop wiring
 * that makes the loop reachable:
 *   - `resolveTeamRepo`: the team workingDir's GitHub repo + default branch,
 *     parsed from the origin remote (`git remote` + `git status`).
 *   - `resolvePrObserveOctokit`: a request-ready client, built from a PAT via the
 *     `gh` CLI (portable; the app may override with a cleaner credential source).
 *   - `runPrReview`: the internal reviewer, run through the team's dispatch via
 *     the run context resolved from the binding's runId.
 *
 * Each is a factory with injectable seams so the logic is unit-tested without
 * Tauri / the CLI / the LLM. All are fail-closed: any resolution miss returns
 * null and the loop stays inert.
 */

import { gitRemotes, gitStatus } from "@/lib/git/commands"
import { getOctokitForRepo } from "@/lib/github/octokit-factory"
import type { OctokitLike } from "@/lib/github/pr-observe/types"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import type { GitRemote, GitStatus } from "@/types/git"
import { getTeamRunContext } from "@/lib/ai/agent/team/team-run-context"
import { dispatchStructured } from "@/lib/ai/agent/team/structured-dispatch"
import {
  buildReviewerPrompt,
  REVIEWER_SYSTEM_PROMPT,
  reviewerVerdictSchema,
  type RunReview,
} from "./reviewer"

/** Parse a GitHub "owner/name" from an https or ssh remote URL. */
export function parseGitHubRepo(url: string): string | null {
  if (!url) return null
  const cleaned = url.trim().replace(/\.git$/, "")
  const m = /github\.com[:/]+([^/]+)\/([^/]+?)$/i.exec(cleaned)
  if (!m) return null
  return `${m[1]}/${m[2]}`
}

export interface ResolveTeamRepoDeps {
  remotes: (workingDir: string) => Promise<GitRemote[]>
  status: (workingDir: string) => Promise<GitStatus>
}

/** Resolve the team's GitHub repo + default (current) branch from its workingDir. */
export function createResolveTeamRepo(
  deps: ResolveTeamRepoDeps = { remotes: gitRemotes, status: gitStatus }
): (workingDir: string) => Promise<{ fullName: string; defaultBranch: string } | null> {
  return async (workingDir) => {
    const remotes = await deps.remotes(workingDir).catch(() => [] as GitRemote[])
    if (remotes.length === 0) return null
    const origin = remotes.find((r) => r.name === "origin") ?? remotes[0]
    const fullName = parseGitHubRepo(origin.fetchUrl || origin.pushUrl || "")
    if (!fullName) return null
    const status = await deps.status(workingDir).catch(() => null)
    const defaultBranch = status?.branch ?? "main"
    return { fullName, defaultBranch }
  }
}

/** Best-effort PAT from the `gh` CLI (`gh auth token`). Returns null on any miss. */
export async function ghCliToken(): Promise<string | null> {
  try {
    const { runHeadlessExec } = await import("@/lib/terminal/headless-exec")
    const out = await runHeadlessExec({
      command: "gh auth token",
      onAskVerdict: "run",
      source: "agent",
      timeoutMs: 15_000,
    })
    if (!out.ok || (out.exitCode !== 0 && out.exitCode !== null)) return null
    // A PTY echoes the command; take the last line that looks like a token.
    const line = out.output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .reverse()
      .find((l) => /^(gh[a-z]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)$/.test(l))
    return line ?? null
  } catch {
    return null
  }
}

export interface ResolveOctokitDeps {
  getToken: () => Promise<string | null>
  build: (opts: {
    repoFullName: string
    mode: "pat"
    pat: { token: string }
  }) => Promise<OctokitLike>
}

/** Build a request-ready octokit for a repo from a resolved PAT. */
export function createResolveOctokit(
  deps: ResolveOctokitDeps = {
    getToken: ghCliToken,
    // The real octokit satisfies OctokitLike at runtime; its typed response
    // headers are `string | number | undefined` (vs. OctokitLike's narrower
    // `string | undefined`), so bridge across the minimal interface here.
    build: (opts) => getOctokitForRepo(opts) as unknown as Promise<OctokitLike>,
  }
): (repoFullName: string) => Promise<OctokitLike | null> {
  return async (repoFullName) => {
    const token = await deps.getToken()
    if (!token) return null
    try {
      return await deps.build({ repoFullName, mode: "pat", pat: { token } })
    } catch {
      return null
    }
  }
}

export interface RunPrReviewDeps {
  getCtx: typeof getTeamRunContext
  dispatch: typeof dispatchStructured
}

/** The internal reviewer, run through the team's dispatch (resolved by runId). */
export function createRunPrReview(
  deps: RunPrReviewDeps = { getCtx: getTeamRunContext, dispatch: dispatchStructured }
): RunReview {
  return async (binding, obs) => {
    const ctx = deps.getCtx(binding.runId)
    if (!ctx) return null
    try {
      // PII gate: the reviewer prompt embeds the PR title (user-derived — for
      // auto-published PRs it is the task description). Redact before it reaches
      // the model, mirroring the `PrReactionEngine.sendOnce` invariant so no
      // locally-derived PR text leaks to the LLM ungated.
      const prompt = buildReviewerPrompt(obs)
      const safePrompt = hasNoLeakingPii(prompt) ? prompt : redactText(prompt).redacted
      const res = await deps.dispatch(
        ctx,
        {
          taskId: `pr-review:${binding.taskId}`,
          prompt: safePrompt,
          systemPrompt: REVIEWER_SYSTEM_PROMPT,
        },
        reviewerVerdictSchema,
        { maxAttempts: 2 }
      )
      return res.value
    } catch {
      return null
    }
  }
}
