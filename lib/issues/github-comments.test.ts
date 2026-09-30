jest.mock("@/lib/ai/agent/team/pr-feedback/resolvers", () => ({
  createResolveOctokit: () => async () => null,
}))
jest.mock("@/lib/db/github-issue-mirror", () => ({ githubMirrorId: jest.fn() }))

import type { OctokitLike } from "@/lib/github/issues"
import { fetchGithubIssueComments } from "./github-comments"

function octokit(pages: Array<{ data: unknown; link?: string }>) {
  const request = jest.fn(async (_route: string, params?: Record<string, unknown>) => {
    const page = pages[Number(params?.page ?? 1) - 1] ?? { data: [] }
    return { status: 200, headers: { link: page.link }, data: page.data }
  })
  return { client: { request } as OctokitLike, request }
}

describe("fetchGithubIssueComments", () => {
  it("reads every page, oldest first, and normalises each comment", async () => {
    const { client, request } = octokit([
      {
        link: '<https://api.github.com/x?page=2>; rel="next"',
        data: [
          {
            id: 1,
            body: "First",
            html_url: "https://github.com/acme/app/issues/5#issuecomment-1",
            created_at: "2026-09-01T00:00:00Z",
            updated_at: "2026-09-02T00:00:00Z",
            user: { login: "octocat", type: "User" },
          },
        ],
      },
      {
        data: [
          {
            id: 2,
            body: null,
            created_at: "2026-09-03T00:00:00Z",
            user: { login: "ci[bot]", type: "Bot" },
          },
          { body: "no id, skipped" },
        ],
      },
    ])
    const result = await fetchGithubIssueComments(
      { repoFullName: "acme/app", number: 5 },
      { resolveOctokit: async () => client }
    )
    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { owner: "acme", repo: "app", issue_number: 5, per_page: 100, page: 1 }
    )
    expect(result).toEqual({
      truncated: false,
      comments: [
        {
          id: 1,
          author: "octocat",
          authorIsBot: false,
          body: "First",
          createdAt: Date.parse("2026-09-01T00:00:00Z"),
          updatedAt: Date.parse("2026-09-02T00:00:00Z"),
          url: "https://github.com/acme/app/issues/5#issuecomment-1",
        },
        {
          id: 2,
          author: "ci[bot]",
          authorIsBot: true,
          body: "",
          createdAt: Date.parse("2026-09-03T00:00:00Z"),
          updatedAt: Date.parse("2026-09-03T00:00:00Z"),
        },
      ],
    })
  })

  it("stops at the page cap and says so", async () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({
      link: '<x>; rel="next"',
      data: [{ id: i + 1, body: "", user: { login: "a" } }],
    }))
    const { client, request } = octokit(pages)
    const result = await fetchGithubIssueComments(
      { repoFullName: "acme/app", number: 5 },
      { resolveOctokit: async () => client }
    )
    expect(request).toHaveBeenCalledTimes(10)
    expect(result.truncated).toBe(true)
  })

  it("reports a missing credential as such", async () => {
    await expect(
      fetchGithubIssueComments(
        { repoFullName: "acme/app", number: 5 },
        { resolveOctokit: async () => null }
      )
    ).rejects.toMatchObject({ name: "MissingGithubCredentialError" })
  })

  it("refuses a malformed repository name", async () => {
    await expect(
      fetchGithubIssueComments(
        { repoFullName: "nope", number: 5 },
        { resolveOctokit: async () => null }
      )
    ).rejects.toThrow("owner/repository")
  })
})
