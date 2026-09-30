import { isTauri } from "@/lib/tauri"
import {
  createResolveOctokit,
  createResolveTeamRepo,
  resolveGithubReadTokenForRepo,
} from "@/lib/ai/agent/team/pr-feedback/resolvers"
import type { GithubHost } from "@/lib/github/host"
import { GitHubPullRequestProvider, type GitHubRepositoryBinding } from "./github-provider"

export interface GitHubRuntimeDeps {
  isLocalRuntime(): boolean
  /**
   * Whether any credential is available, before a repository is known. With
   * no repository to scope the answer, this asks about github.com: a connected
   * github.com account or a `gh` login both count.
   */
  getToken(): Promise<string | null>
  resolveRepository(
    repositoryRoot: string
  ): Promise<{ fullName: string; defaultBranch: string; host?: GithubHost } | null>
  resolveClient(
    fullName: string,
    host?: GithubHost
  ): Promise<GitHubRepositoryBinding["client"] | null>
}

/**
 * Production GitHub adapter backed by the shared read-credential path: a
 * connected integration account first, the `gh` CLI second.
 */
export function createGitHubPullRequestProvider(
  deps: GitHubRuntimeDeps = {
    isLocalRuntime: isTauri,
    // No repository yet, so the owner is unknown; an empty name ranks every
    // github.com account equally.
    getToken: () => resolveGithubReadTokenForRepo(""),
    resolveRepository: createResolveTeamRepo(),
    resolveClient: createResolveOctokit(),
  }
): GitHubPullRequestProvider {
  return new GitHubPullRequestProvider({
    authenticationState: async () => {
      if (!deps.isLocalRuntime()) return "unavailable"
      return (await deps.getToken()) ? "authenticated" : "unauthenticated"
    },
    resolveRepository: async (repositoryRoot) => {
      if (!deps.isLocalRuntime()) throw new Error("GitHub pull requests require local Tauri")
      const repository = await deps.resolveRepository(repositoryRoot)
      if (!repository) throw new Error("The selected root has no GitHub remote")
      const client = await deps.resolveClient(repository.fullName, repository.host)
      if (!client) throw new Error("GitHub authentication is required")
      const [owner, repo] = repository.fullName.split("/")
      if (!owner || !repo) throw new Error("The GitHub remote is invalid")
      return { owner, repo, fullName: repository.fullName, client }
    },
  })
}
