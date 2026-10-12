import { githubResponse } from "@cognia/github-bot-kit/testing"

import { AUTHOR, fixture, issueComment, NOW, REPOSITORY } from "./comment-bot.test-helpers"
import { readerFor } from "./identity"
import { initialCursor, POLL_MAX_PAGES, pollCandidates } from "./poll"

const repository = { id: "4242", fullName: REPOSITORY }

it("finds conversation comments, line comments and reviews since each cursor", async () => {
  const f = fixture()
  f.github.comments.set(11, issueComment(11, "@cognia-bot ask"))
  f.github.reviewComments.set(12, {
    ...issueComment(12, "@cognia-bot ask"),
    pull_request_url: `https://api.github.com/repos/${REPOSITORY}/pulls/8`,
  })
  const pr = f.github.items.get(8)!
  f.github.items.set(8, { ...pr, updated_at: new Date(NOW - 1000).toISOString() })
  f.github.reviews.set(13, {
    id: 13,
    body: "@cognia-bot review",
    submitted_at: new Date(NOW - 2000).toISOString(),
    user: AUTHOR,
    state: "COMMENTED",
  })
  f.github.reviews.set(14, {
    id: 14,
    body: "old",
    submitted_at: "2020-01-01T00:00:00Z",
    user: AUTHOR,
  })
  const cursor = initialCursor(NOW - 3_600_000)
  const { candidates, next } = await pollCandidates(
    readerFor(f.context, f.run, f.config),
    repository,
    cursor,
    NOW
  )
  expect(
    candidates.map((candidate) => [candidate.raw.sourceKind, candidate.raw.id, candidate.ingress])
  ).toEqual([
    ["issue_comment", 11, "poll"],
    ["review_comment", 12, "poll"],
    ["review", 13, "poll"],
  ])
  const settled = new Date(NOW - 1000).toISOString()
  expect(next).toMatchObject({
    issueCommentsSince: settled,
    reviewCommentsSince: settled,
    reviewsSince: settled,
    lastScanAt: NOW,
  })
  const urls = f.mocks.request.mock.calls.map((call) => call[1] as string)
  expect(urls).toContain(
    `/repos/${REPOSITORY}/issues/comments?sort=updated&direction=asc&since=${encodeURIComponent(cursor.issueCommentsSince)}&per_page=100&page=1`
  )
})

it("keeps an empty listing's URL and ETag so the next scan is a free 304", async () => {
  const f = fixture()
  f.github.overrides.set("/issues/comments", githubResponse([], { headers: { etag: '"e1"' } }))
  const reader = readerFor(f.context, f.run, f.config)
  const cursor = initialCursor(NOW - 3_600_000)
  const first = await pollCandidates(reader, repository, cursor, NOW)
  expect(first.next.issueCommentsSince).toBe(cursor.issueCommentsSince)
  expect(first.next.issueCommentsEtag).toBe('"e1"')
  f.github.overrides.set("/issues/comments", githubResponse(undefined, { status: 304 }))
  const second = await pollCandidates(reader, repository, first.next, NOW + 60_000)
  expect(second.next.issueCommentsSince).toBe(cursor.issueCommentsSince)
  const etagged = f.mocks.request.mock.calls.filter(
    (call) => call[2]?.headers?.["If-None-Match"] === '"e1"'
  )
  expect(etagged).toHaveLength(1)
})

it("resumes from the newest version read when a busy repository has more pages", async () => {
  const f = fixture()
  const updated = (n: number) => new Date(NOW - 100_000 + n).toISOString()
  f.github.overrides.set(
    "/issues/comments",
    githubResponse(
      [
        issueComment(1, "x", { updated_at: updated(5) }),
        issueComment(2, "y", { updated_at: updated(9) }),
      ],
      {
        headers: { link: '<next>; rel="next"' },
      }
    )
  )
  const { next } = await pollCandidates(
    readerFor(f.context, f.run, f.config),
    repository,
    initialCursor(NOW - 3_600_000),
    NOW
  )
  expect(next.issueCommentsSince).toBe(updated(9))
  expect(next.issueCommentsEtag).toBeUndefined()
  const pages = f.mocks.request.mock.calls.filter((call) =>
    String(call[1]).includes("/issues/comments?")
  )
  expect(pages).toHaveLength(POLL_MAX_PAGES)
})
