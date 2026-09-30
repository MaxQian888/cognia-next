/**
 * Production resolvers for the Agent Team PR feedback deps — the desktop wiring
 * that makes the loop reachable:
 *   - `resolveTeamRepo`: the team workingDir's GitHub repo + default branch,
 *     parsed from the origin remote (`git remote` + `git_default_branch`).
 *   - `resolvePrObserveOctokit`: a request-ready client for the repository's
 *     own GitHub deployment, from a connected integration account (PAT or App)
 *     first and the `gh` CLI second.
 *   - `runPrReview`: the internal reviewer, run through the team's dispatch via
 *     the run context resolved from the binding's runId.
 *
 * Each is a factory with injectable seams so the logic is unit-tested without
 * Tauri / the CLI / the LLM. All are fail-closed: any resolution miss returns
 * null and the loop stays inert.
 */

import { gitDefaultBranch, gitRemotes } from "@/lib/git/commands"
import { parseForgeRemote } from "@/lib/stack/forge/remote"
import { getOctokitForRepo } from "@/lib/github/octokit-factory"
import { GITHUB_DOT_COM, isGithubDotCom, type GithubHost } from "@/lib/github/host"
import type { OctokitLike } from "@/lib/github/pr-observe/types"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import type { GitDefaultBranch, GitRemote } from "@/types/git"
import { getTeamRunContext } from "@/lib/ai/agent/team/team-run-context"
import { dispatchStructured } from "@/lib/ai/agent/team/teammate/structured-dispatch"
import {
  buildReviewerPrompt,
  REVIEWER_SYSTEM_PROMPT,
  reviewerVerdictSchema,
  type RunReview,
} from "./reviewer"

/**
 * Parse a GitHub "owner/name" from an https or ssh remote URL.
 *
 * Delegates to the stack engine's parser rather than carrying a second regex:
 * that one also distinguishes "a host we have no adapter for" from "not a
 * remote at all", and two parsers that disagree about `github.acme.com` is how
 * a token ends up at the wrong host.
 */
export function parseGitHubRepo(url: string): string | null {
  const parsed = parseForgeRemote(url)
  return parsed?.forge === "github" ? parsed.fullName : null
}

export interface ResolveTeamRepoDeps {
  remotes: (workingDir: string) => Promise<GitRemote[]>
  defaultBranch: (workingDir: string, remote?: string) => Promise<GitDefaultBranch>
  /**
   * The GitHub deployments the user has an account on (ADR-0176). A GitHub
   * Enterprise remote is a GitHub repository only once its host is configured.
   */
  hosts?: () => Promise<GithubHost[]>
}

export interface ResolvedTeamRepo {
  fullName: string
  /** The deployment the repository lives on — every read must go there. */
  host: GithubHost
  /** The repository's trunk — never the branch that happens to be checked out. */
  defaultBranch: string
  /** How that name was arrived at, so a caller can refuse to build on a guess. */
  defaultBranchSource: GitDefaultBranch["source"]
  /** Whether the name resolves to a commit in this repository. */
  defaultBranchExists: boolean
}

/**
 * Resolve the team's GitHub repo + trunk from its workingDir.
 *
 * The trunk comes from `git_default_branch`, not from `git status`. Reading it
 * off the checkout was a defect with a narrow tell: it looks right in every
 * test and every demo, because those run on the trunk. Anywhere else — an
 * agent working on `feature/x`, a task worktree, a bisect — it reported that
 * feature branch as the repository's default, and both consumers build on the
 * answer: PR feedback opens pull requests against it, and the stack publisher
 * roots the entire stack on it.
 */
async function defaultConfiguredHosts(): Promise<GithubHost[]> {
  // Lazy: the account registry belongs to the application, and a static import
  // would drag it into every consumer of these resolvers' tests.
  const { configuredGithubHosts } = await import("@/lib/integrations/github-auth")
  return configuredGithubHosts()
}

export function createResolveTeamRepo(
  deps: ResolveTeamRepoDeps = {
    remotes: gitRemotes,
    defaultBranch: gitDefaultBranch,
    hosts: defaultConfiguredHosts,
  }
): (workingDir: string) => Promise<ResolvedTeamRepo | null> {
  return async (workingDir) => {
    const remotes = await deps.remotes(workingDir).catch(() => [] as GitRemote[])
    if (remotes.length === 0) return null
    const origin = remotes.find((r) => r.name === "origin") ?? remotes[0]
    // A failure to enumerate accounts still recognises github.com.
    const hosts = deps.hosts ? await deps.hosts().catch(() => [] as GithubHost[]) : []
    const parsed = parseForgeRemote(origin.fetchUrl || origin.pushUrl || "", hosts)
    if (parsed?.forge !== "github") return null
    const fullName = parsed.fullName
    const trunk = await deps
      .defaultBranch(workingDir, origin.name)
      .catch(() => ({ branch: "main", source: "guess", exists: false }) as GitDefaultBranch)
    return {
      fullName,
      host: parsed.host,
      defaultBranch: trunk.branch,
      defaultBranchSource: trunk.source,
      defaultBranchExists: trunk.exists,
    }
  }
}

/** A hostname safe to pass to `gh --hostname` unquoted. */
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

/**
 * Best-effort PAT from the `gh` CLI (`gh auth token`). Returns null on any miss.
 *
 * For a GitHub Enterprise host this asks for *that* host's token
 * (`--hostname`): plain `gh auth token` answers for github.com, and that token
 * is useless — and should never be sent — to an enterprise server.
 */
export async function ghCliToken(host: GithubHost = GITHUB_DOT_COM): Promise<string | null> {
  let command = "gh auth token"
  if (!isGithubDotCom(host)) {
    if (!HOSTNAME_RE.test(host.id)) return null
    command = `gh auth token --hostname ${host.id}`
  }
  try {
    const { runHeadlessExec } = await import("@/lib/terminal/headless-exec")
    const out = await runHeadlessExec({
      command,
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

/**
 * A read token for `repoFullName` on `host`: a connected integration account
 * first (Settings → Connections), then the `gh` CLI signed in to that host.
 * Null when neither has one.
 */
export async function resolveGithubReadTokenForRepo(
  repoFullName: string,
  host: GithubHost = GITHUB_DOT_COM
): Promise<string | null> {
  try {
    const { resolveGithubReadToken } = await import("@/lib/integrations/github-read-credential")
    const fromAccount = await resolveGithubReadToken(repoFullName, host)
    if (fromAccount) return fromAccount
  } catch {
    // Fall through to the CLI: a broken account store must not also take the
    // `gh` credential away.
  }
  return ghCliToken(host)
}

export interface ResolveOctokitDeps {
  getToken: (repoFullName: string, host: GithubHost) => Promise<string | null>
  build: (opts: {
    repoFullName: string
    mode: "pat"
    pat: { token: string }
    host: GithubHost
  }) => Promise<OctokitLike>
}

/**
 * Build a request-ready octokit for a repo on its own deployment.
 *
 * `host` defaults to github.com, which is what a bare `owner/name` means. A
 * caller that parsed a GitHub Enterprise remote must pass that host: both the
 * credential and the REST root are chosen from it.
 */
export function createResolveOctokit(
  deps: ResolveOctokitDeps = {
    getToken: resolveGithubReadTokenForRepo,
    // The real octokit satisfies OctokitLike at runtime; its typed response
    // headers are `string | number | undefined` (vs. OctokitLike's narrower
    // `string | undefined`), so bridge across the minimal interface here.
    build: (opts) => getOctokitForRepo(opts) as unknown as Promise<OctokitLike>,
  }
): (repoFullName: string, host?: GithubHost) => Promise<OctokitLike | null> {
  return async (repoFullName, host = GITHUB_DOT_COM) => {
    const token = await deps.getToken(repoFullName, host).catch(() => null)
    if (!token) return null
    try {
      return await deps.build({ repoFullName, mode: "pat", pat: { token }, host })
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
