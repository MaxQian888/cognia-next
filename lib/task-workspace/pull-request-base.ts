import { createGitHubPullRequestProvider } from "@/lib/review/github-runtime"
import type { PullRequestProvider } from "@/types/review"
import type { WorkspaceBaseSpec } from "./types"

export async function resolvePullRequestWorkspaceBase(
  repositoryRoot: string,
  base: WorkspaceBaseSpec,
  providerOverride?: PullRequestProvider
): Promise<WorkspaceBaseSpec> {
  if (base.kind !== "pullRequest") return base
  const provider =
    providerOverride ?? (base.provider === "github" ? createGitHubPullRequestProvider() : null)
  if (!provider || provider.id !== base.provider) {
    throw new Error(`Unsupported pull request provider: ${base.provider}`)
  }
  const resolution = await provider.resolveCheckout(repositoryRoot, {
    repository: base.repo,
    number: base.number,
  })
  if (
    resolution.provider !== base.provider ||
    resolution.repository.toLowerCase() !== base.repo.toLowerCase() ||
    resolution.number !== base.number
  ) {
    throw new Error("Pull request provider returned a mismatched checkout resolution")
  }
  return { ...base, fetchRef: resolution.fetchRef, headSha: resolution.headSha }
}
