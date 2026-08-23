const gitPushMock = jest.fn()
jest.mock("@/lib/git/commands", () => ({
  gitPush: (...args: unknown[]) => gitPushMock(...args),
}))

import { GitHubPullRequestProvider, PullRequestProviderError } from "./github-provider"
import type { ReviewFeedbackBundle } from "@/types/review"

const request = jest.fn()
const provider = new GitHubPullRequestProvider({
  authenticationState: async () => "authenticated",
  resolveRepository: async () => ({
    owner: "owner",
    repo: "repo",
    fullName: "owner/repo",
    client: { request },
  }),
})

beforeEach(() => {
  request.mockReset()
  gitPushMock.mockReset().mockResolvedValue(undefined)
})

it("reports authentication and discovers the branch PR", async () => {
  request.mockResolvedValue({
    status: 200,
    data: [
      {
        number: 42,
        html_url: "https://github.com/owner/repo/pull/42",
        title: "Change",
        state: "open",
        head: { ref: "codex/change" },
        base: { ref: "main" },
      },
    ],
  })
  await expect(provider.getAuthenticationState()).resolves.toBe("authenticated")
  await expect(provider.findForBranch("/repo", "codex/change")).resolves.toEqual(
    expect.objectContaining({ number: 42, repository: "owner/repo", provider: "github" })
  )
})

it("pushes through the existing native Git bridge and preserves rejection", async () => {
  await provider.push("/repo", "codex/change")
  expect(gitPushMock).toHaveBeenCalledWith("/repo", {
    remote: "origin",
    branch: "codex/change",
    setUpstream: true,
  })
  gitPushMock.mockRejectedValueOnce(new Error("non-fast-forward"))
  await expect(provider.push("/repo", "codex/change")).rejects.toMatchObject({
    operation: "push",
    recoverable: false,
  })
})

it("creates a draft PR", async () => {
  request.mockResolvedValue({
    status: 201,
    data: { number: 7, html_url: "https://github.com/o/r/pull/7", state: "open" },
  })
  await expect(
    provider.create({
      repositoryRoot: "/repo",
      headRef: "codex/change",
      baseRef: "main",
      title: "Change",
      body: "Body",
      draft: true,
    })
  ).resolves.toEqual(expect.objectContaining({ number: 7, headRef: "codex/change" }))
  expect(request).toHaveBeenCalledWith(
    "POST /repos/{owner}/{repo}/pulls",
    expect.objectContaining({ draft: true })
  )
})

it("publishes the editable bundle as one GitHub review and omits stale comments", async () => {
  request.mockResolvedValue({ status: 200, data: {} })
  const bundle: ReviewFeedbackBundle = {
    id: "bundle-1",
    sessionId: "session-1",
    scope: "branch",
    repositoryRoots: ["/repo"],
    summary: "Review summary",
    state: "draft",
    createdAt: 1,
    updatedAt: 1,
    comments: [
      {
        id: "comment-1",
        contentHash: "hash",
        anchor: {
          repositoryRoot: "/repo",
          path: "src/a.ts",
          hunkHash: "hunk",
          side: "after",
          line: 4,
          commitSha: "abc",
        },
        body: "Fix this",
        createdAt: 1,
        updatedAt: 1,
        status: "draft",
      },
      {
        id: "comment-stale",
        contentHash: "stale",
        anchor: {
          repositoryRoot: "/repo",
          path: "src/b.ts",
          hunkHash: "gone",
          side: "after",
          line: 1,
        },
        body: "Gone",
        createdAt: 1,
        updatedAt: 1,
        status: "stale",
      },
    ],
  }
  await provider.publishFeedback(
    {
      provider: "github",
      repository: "owner/repo",
      number: 42,
      url: "url",
      headRef: "head",
      baseRef: "main",
      title: "title",
      state: "open",
    },
    bundle
  )
  expect(request).toHaveBeenCalledWith(
    "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    expect.objectContaining({
      body: "Review summary",
      comments: [expect.objectContaining({ path: "src/a.ts", line: 4 })],
    })
  )
})

it("marks offline failures recoverable for retry", async () => {
  request.mockRejectedValue(Object.assign(new Error("network offline"), { code: "ENETDOWN" }))
  await expect(provider.findForBranch("/repo", "branch")).rejects.toEqual(
    expect.objectContaining({
      name: "PullRequestProviderError",
      operation: "lookup",
      recoverable: true,
    })
  )
  expect(PullRequestProviderError).toBeDefined()
})

/**
 * The live bug this replaced: `publishFeedback` took `repositoryRoots[0]` and
 * posted EVERY comment against that repository, so in a two-root review the
 * second repository's comments landed on the first repository's pull request.
 */
it("refuses a multi-root bundle instead of posting it all to the first root", async () => {
  request.mockResolvedValue({ status: 200, data: {} })
  const multiRoot: ReviewFeedbackBundle = {
    id: "bundle-2",
    sessionId: "session-1",
    scope: "branch",
    repositoryRoots: ["/repo-a", "/repo-b"],
    summary: "Review summary",
    state: "draft",
    createdAt: 1,
    updatedAt: 1,
    comments: [
      {
        id: "c-a",
        contentHash: "a",
        anchor: {
          repositoryRoot: "/repo-a",
          path: "src/a.ts",
          hunkHash: "h",
          side: "after",
          line: 1,
        },
        body: "In A",
        createdAt: 1,
        updatedAt: 1,
        status: "draft",
      },
      {
        id: "c-b",
        contentHash: "b",
        anchor: {
          repositoryRoot: "/repo-b",
          path: "src/b.ts",
          hunkHash: "h",
          side: "after",
          line: 2,
        },
        body: "In B",
        createdAt: 1,
        updatedAt: 1,
        status: "draft",
      },
    ],
  }
  await expect(
    provider.publishFeedback(
      {
        provider: "github",
        repository: "owner/repo",
        number: 42,
        url: "url",
        headRef: "head",
        baseRef: "main",
        title: "title",
        state: "open",
      },
      multiRoot
    )
  ).rejects.toMatchObject({ operation: "feedback" })
  expect(request).not.toHaveBeenCalled()
})

it("refuses a single-root bundle that smuggles in a foreign comment", async () => {
  request.mockResolvedValue({ status: 200, data: {} })
  const smuggled: ReviewFeedbackBundle = {
    id: "bundle-3",
    sessionId: "session-1",
    scope: "branch",
    repositoryRoots: ["/repo"],
    summary: "Review summary",
    state: "draft",
    createdAt: 1,
    updatedAt: 1,
    comments: [
      {
        id: "c-other",
        contentHash: "o",
        anchor: {
          repositoryRoot: "/elsewhere",
          path: "src/secret.ts",
          hunkHash: "h",
          side: "after",
          line: 3,
        },
        body: "Leaks to the wrong repo",
        createdAt: 1,
        updatedAt: 1,
        status: "draft",
      },
    ],
  }
  await expect(
    provider.publishFeedback(
      {
        provider: "github",
        repository: "owner/repo",
        number: 42,
        url: "url",
        headRef: "head",
        baseRef: "main",
        title: "title",
        state: "open",
      },
      smuggled
    )
  ).rejects.toMatchObject({ operation: "feedback" })
  expect(request).not.toHaveBeenCalled()
})

/** `recoverable` asks "retry?"; `outcomeUncertain` asks "might a retry duplicate?". */
it("separates a definite HTTP failure from a request that got no answer", async () => {
  request.mockRejectedValueOnce(Object.assign(new Error("Validation failed"), { status: 422 }))
  await expect(provider.findForBranch("/repo", "branch")).rejects.toMatchObject({
    status: 422,
    outcomeUncertain: false,
  })

  request.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
  await expect(provider.findForBranch("/repo", "branch")).rejects.toMatchObject({
    recoverable: true,
    outcomeUncertain: true,
  })
})
