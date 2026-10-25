import type { ChatSession } from "@cognia/agent-config-types"
import type { OctokitLike, PrDerivedStatus } from "@/lib/github/pr-observe/types"
import { createGithubStackAdapter } from "@/lib/stack/forge/github"
import { publishTeammatePr, type PublishedPr } from "@/lib/ai/agent/team/pr-feedback/publish"
import { gitPush } from "@/lib/git/commands"
import { getProjectPrWatch, type ProjectPrWatch } from "./pr-watch"
import { createResolveTeamRepo } from "@/lib/ai/agent/team/pr-feedback/resolvers"
import { recordHumanGithubWrite } from "@/lib/policy/action-review/human-github-write"
import { repositoryOnHost, repositoryTarget } from "@/lib/policy/action-review/outbound-targets"

/**
 * The pull-request actions a person takes on a thread (ADR-0204). "Fix CI",
 * "Address comments" and "Resolve conflicts" are instructions to the thread —
 * the UI sends them through `sendToThread` as the user's own message, so the
 * thread does the work in its own worktree with its own permissions. "Merge" and "Create PR" act on GitHub
 * directly through the same clients the stack engine and team publisher use.
 */

export type ThreadPrInstruction = "fix-ci" | "address-comments" | "resolve-conflicts"
export type ThreadPrAction = ThreadPrInstruction | "merge" | "review" | "create"

/** Which actions apply to a thread in a given PR state. */
export function availablePrActions(
  thread: Pick<ChatSession, "executionContext" | "projectThread">,
  status: PrDerivedStatus | undefined
): ThreadPrAction[] {
  const hasPr = Boolean(thread.projectThread?.prRef?.url)
  if (!hasPr || !status || status === "none") {
    return thread.executionContext?.branch && thread.executionContext.worktreePath ? ["create"] : []
  }
  switch (status) {
    case "ci_failed":
      return ["fix-ci", "review"]
    case "changes_requested":
      return ["address-comments", "review"]
    case "merge_conflict":
      return ["resolve-conflicts", "review"]
    case "approved":
    case "mergeable":
      return ["merge", "review"]
    case "merged":
    case "closed":
      return []
    default:
      return ["review"]
  }
}

function requireOctokit(watch: ProjectPrWatch, repo: string): OctokitLike {
  const octokit = watch.octokitFor(repo)
  if (!octokit) throw new Error(`No GitHub access for ${repo}`)
  return octokit
}

/**
 * Squash-merge the thread's pull request. A person's confirmed button, so it
 * records a human receipt for the repository first (ADR-0239 phase 2).
 */
export async function mergeThreadPr(
  thread: Pick<ChatSession, "projectThread"> & { id?: string },
  watch: ProjectPrWatch = getProjectPrWatch(),
  record: typeof recordHumanGithubWrite = recordHumanGithubWrite
): Promise<void> {
  const pr = thread.projectThread?.prRef
  if (!pr?.number) throw new Error("This thread has no pull request to merge")
  const octokit = requireOctokit(watch, pr.repo)
  await record({
    targets: [repositoryTarget(pr.repo)],
    operation: "github.mergePr",
    surface: "thread-pr",
    ...(thread.id ? { sessionId: thread.id } : {}),
  })
  await createGithubStackAdapter({ octokit }).merge(pr.repo, pr.number, "squash")
}

/**
 * Push the thread's branch and open a pull request for it (idempotent). A
 * person's button, so it records a human receipt first (ADR-0239 phase 2).
 */
export async function createThreadPr(
  thread: Pick<ChatSession, "id" | "title" | "executionContext">,
  deps: {
    watch: ProjectPrWatch
    push: (worktreePath: string, branch: string) => Promise<void>
    resolveBase: (
      workingDir: string
    ) => Promise<{ fullName: string; defaultBranch: string; host?: { id: string } } | null>
    record?: typeof recordHumanGithubWrite
  } = {
    watch: getProjectPrWatch(),
    push: pushThreadBranch,
    resolveBase: createResolveTeamRepo(),
  }
): Promise<PublishedPr | null> {
  const branch = thread.executionContext?.branch
  const worktreePath = thread.executionContext?.worktreePath
  if (!branch || !worktreePath) throw new Error("This thread has no branch to publish")
  const repo = await deps.resolveBase(worktreePath)
  if (!repo) throw new Error("The thread's repository is not on github.com")
  const octokit = requireOctokit(deps.watch, repo.fullName)
  await (deps.record ?? recordHumanGithubWrite)({
    targets: [repositoryOnHost(repo.fullName, repo.host?.id)],
    operation: "github.openPr",
    surface: "thread-pr",
    sessionId: thread.id,
  })
  return publishTeammatePr(
    octokit,
    { push: deps.push },
    {
      repo: repo.fullName,
      branch,
      baseBranch: repo.defaultBranch,
      worktreePath,
      title: thread.title,
      draft: true,
    }
  )
}

/** Production push seam, matching the team publisher's. */
export function pushThreadBranch(worktreePath: string, branch: string): Promise<void> {
  return gitPush(worktreePath, { remote: "origin", branch, setUpstream: true })
}
