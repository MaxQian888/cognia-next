import { parseGithubHost } from "@/lib/github/host"
import { createGitHubPullRequestProvider } from "./github-runtime"

const client = { request: jest.fn() }

it("constructs the GitHub provider from the existing local credential resolver", async () => {
  const provider = createGitHubPullRequestProvider({
    isLocalRuntime: () => true,
    getToken: async () => "github_pat_token",
    resolveRepository: async () => ({ fullName: "acme/cognia", defaultBranch: "main" }),
    resolveClient: async () => client,
  })
  await expect(provider.getAuthenticationState()).resolves.toBe("authenticated")
  client.request.mockResolvedValueOnce({ status: 200, data: [] })
  await provider.findForBranch("/repo", "feature")
  expect(client.request).toHaveBeenCalledWith(
    "GET /repos/{owner}/{repo}/pulls",
    expect.objectContaining({ owner: "acme", repo: "cognia" })
  )
})

it("resolves the client on the repository's own GitHub deployment", async () => {
  const ghes = parseGithubHost("https://ghe.acme.io")!
  const resolveClient = jest.fn(async () => client)
  const provider = createGitHubPullRequestProvider({
    isLocalRuntime: () => true,
    getToken: async () => "t",
    resolveRepository: async () => ({ fullName: "acme/cognia", defaultBranch: "main", host: ghes }),
    resolveClient,
  })
  client.request.mockResolvedValueOnce({ status: 200, data: [] })
  await provider.findForBranch("/repo", "feature")
  expect(resolveClient).toHaveBeenCalledWith("acme/cognia", ghes)
})

it("reports web as unavailable and missing local credentials as unauthenticated", async () => {
  const web = createGitHubPullRequestProvider({
    isLocalRuntime: () => false,
    getToken: async () => "token",
    resolveRepository: async () => null,
    resolveClient: async () => null,
  })
  await expect(web.getAuthenticationState()).resolves.toBe("unavailable")
  const local = createGitHubPullRequestProvider({
    isLocalRuntime: () => true,
    getToken: async () => null,
    resolveRepository: async () => null,
    resolveClient: async () => null,
  })
  await expect(local.getAuthenticationState()).resolves.toBe("unauthenticated")
})

it("authenticates GHES roots without requiring a github.com credential", async () => {
  const host = parseGithubHost("https://ghe.acme.io")!
  const getToken = jest.fn(async () => null)
  const provider = createGitHubPullRequestProvider({
    isLocalRuntime: () => true,
    getToken,
    resolveRepository: async (root) =>
      root === "/enterprise" ? { fullName: "acme/repo", defaultBranch: "main", host } : null,
    resolveClient: async (_name, target) => (target?.id === host.id ? client : null),
  })
  await expect(provider.getAuthenticationState("/enterprise")).resolves.toBe("authenticated")
  await expect(provider.getAuthenticationState("/missing")).resolves.toBe("unavailable")
  expect(getToken).not.toHaveBeenCalled()
})
