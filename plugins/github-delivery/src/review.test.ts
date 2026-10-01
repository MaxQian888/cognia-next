import { publishGithubReview, type GithubReviewRequest } from "./review"

it("shares exact-head and inline retry reconciliation across transports", async () => {
  const comment = { path: "a.ts", line: 2, side: "RIGHT", body: "Fix" }
  const request = jest
    .fn()
    .mockResolvedValueOnce({ data: { state: "open", head: { sha: "abc" } } })
    .mockResolvedValueOnce({ data: [{ id: 5, body: "", commit_id: "abc", state: "COMMENTED" }] })
    .mockResolvedValueOnce({ data: [comment] })
  await expect(
    publishGithubReview(
      {
        repoFullName: "owner/repo",
        prNumber: 42,
        commitId: "abc",
        comments: [comment],
      },
      request as GithubReviewRequest
    )
  ).resolves.toMatchObject({ id: 5 })
  expect(request).toHaveBeenCalledTimes(3)
  expect(request.mock.calls.every(([, method]) => method !== "POST")).toBe(true)
})

it("refuses a cached inline review with different content instead of suppressing the new feedback", async () => {
  const request = jest
    .fn()
    .mockResolvedValueOnce({ data: { state: "open", head: { sha: "abc" } } })
    .mockResolvedValueOnce({ data: [{ id: 5, body: "", commit_id: "abc", state: "COMMENTED" }] })
    .mockResolvedValueOnce({ data: [{ path: "a.ts", line: 2, side: "RIGHT", body: "Old" }] })
  await expect(
    publishGithubReview(
      {
        repoFullName: "owner/repo",
        prNumber: 42,
        commitId: "abc",
        comments: [{ path: "a.ts", line: 2, side: "RIGHT", body: "New" }],
      },
      request as GithubReviewRequest
    )
  ).rejects.toThrow(/content differs/)
})
