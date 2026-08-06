import { isTauri } from "@/lib/tauri"
import {
  createResolveOctokit,
  createResolveTeamRepo,
  ghCliToken,
} from "@/lib/ai/agent/team/pr-feedback/resolvers"
import { GitHubPullRequestProvider, type GitHubRepositoryBinding } from "./github-provider"

export interface GitHubRuntimeDeps {
  isLocalRuntime(): boolean
  getToken(): Promise<string | null>
  resolveRepository(
    repositoryRoot: string
  ): Promise<{ fullName: string; defaultBranch: string } | null>
  resolveClient(fullName: string): Promise<GitHubRepositoryBinding["client"] | null>
}

/** Production GitHub adapter backed by the existing `gh`/Octokit credential path. */
export function createGitHubPullRequestProvider(
  deps: GitHubRuntimeDeps = {
    isLocalRuntime: isTauri,
    getToken: ghCliToken,
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
      const client = await deps.resolveClient(repository.fullName)
      if (!client) throw new Error("GitHub authentication is required")
      const [owner, repo] = repository.fullName.split("/")
      if (!owner || !repo) throw new Error("The GitHub remote is invalid")
      return { owner, repo, fullName: repository.fullName, client }
    },
  })
}
