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
