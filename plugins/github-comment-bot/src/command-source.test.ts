import {
  commandEventId,
  fromIssueComment,
  fromReview,
  fromReviewComment,
  parseCommandComment,
  parseCommandSource,
  parseReplyTarget,
  replyTargetOf,
  sha256Hex,
  sourceResourceId,
  TASK_REF,
  taskRef,
  threadPrefix,
  toCommandSource,
  toReplyTarget,
} from "./command-source"

const user = { id: 42, login: "octo-cat", type: "User" }

it("reads conversation comments from webhooks and from polling", () => {
  const comment = {
    id: 1,
    body: "@bot ask why",
    created_at: "2026-10-12T00:00:00Z",
    updated_at: "2026-10-12T00:01:00Z",
    html_url: "https://github.com/acme/widgets/issues/7#issuecomment-1",
    issue_url: "https://api.github.com/repos/acme/widgets/issues/7",
    user,
  }
  expect(fromIssueComment(comment, { number: 7, pull_request: { url: "x" } })).toMatchObject({
    sourceKind: "issue_comment",
    id: 1,
    revision: "2026-10-12T00:01:00Z",
    threadNumber: 7,
    threadKind: "pull_request",
  })
  // Polling has no issue object: the thread kind is unknown until it is read.
  const polled = fromIssueComment(comment)
  expect(polled).toMatchObject({ threadNumber: 7 })
  expect(polled).not.toHaveProperty("threadKind")
  expect(fromIssueComment({ ...comment, user: null })).toBeUndefined()
  expect(fromIssueComment({ ...comment, issue_url: "x" })).toBeUndefined()
})

it("reads line comments with their location, and reviews but not pending drafts", () => {
  expect(
    fromReviewComment({
      id: 2,
      body: "b",
      created_at: "t1",
      updated_at: "t2",
      pull_request_url: "https://api.github.com/repos/acme/widgets/pulls/8",
      path: "src/a.ts",
      original_line: 4,
      commit_id: "c",
      in_reply_to_id: 1,
      user,
    })
  ).toMatchObject({
    sourceKind: "review_comment",
    threadNumber: 8,
    threadKind: "pull_request",
    review: { path: "src/a.ts", line: 4, commitId: "c", inReplyToId: 1 },
  })
  expect(
    fromReview({ id: 3, body: "x", submitted_at: "t", user, state: "COMMENTED" }, 8)
  ).toMatchObject({
    sourceKind: "review",
    revision: "t",
    threadNumber: 8,
  })
  expect(fromReview({ id: 3, submitted_at: "t", user, state: "PENDING" }, 8)).toBeUndefined()
})

it("names resources, events and tasks without exposing anything", async () => {
  expect(sourceResourceId("Acme/Widgets", 7, "issue_comment", 1)).toBe(
    "acme/widgets#7:issue_comment:1"
  )
  expect(
    sourceResourceId("acme/widgets", 7, "review", 3).startsWith(threadPrefix("acme/widgets", 7))
  ).toBe(true)
  expect(threadPrefix("acme/widgets", 7)).not.toBe(threadPrefix("acme/widgets", 70).slice(0, -1))
  const ref = await taskRef("acme/widgets#7:issue_comment:1")
  expect(ref).toMatch(TASK_REF)
  expect(ref).toBe(await taskRef("acme/widgets#7:issue_comment:1"))
  expect(await sha256Hex("")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  )
})

it("builds a source record and validates one handed back by the Bot plane", async () => {
  const raw = fromIssueComment(
    {
      id: 1,
      body: "@bot ask why",
      created_at: "c",
      updated_at: "u",
      issue_url: "https://api.github.com/repos/acme/widgets/issues/7",
      user,
    },
    { number: 7 }
  )!
  const parsed = parseCommandComment(raw.body, "@bot")
  if (parsed.kind !== "command") throw new Error("expected a command")
  const source = await toCommandSource(
    { ...raw, threadKind: "issue" },
    { id: "4242", fullName: "acme/widgets" },
    "webhook",
    parsed
  )
  expect(source).toMatchObject({ verb: "ask", request: "why", aliased: false, sourceId: "1" })
  expect(commandEventId(source)).toBe("gh-cmd:4242:issue_comment:1:u")
  expect(parseCommandSource(source, "ACME/widgets")).toBe(source)
  for (const bad of [
    null,
    { ...source, repository: "other/repo" },
    { ...source, verb: "merge" },
    { ...source, sourceId: "../1" },
    { ...source, threadNumber: 0 },
    { ...source, schemaVersion: 2 },
  ])
    expect(() => parseCommandSource(bad, "acme/widgets")).toThrow("Invalid or out-of-scope")

  const target = await toReplyTarget(
    { ...raw, threadKind: "issue" },
    { id: "4242", fullName: "acme/widgets" },
    "poll"
  )
  expect(target).not.toHaveProperty("verb")
  expect(replyTargetOf(source)).not.toHaveProperty("request")
  expect(parseReplyTarget(target, "acme/widgets")).toEqual(target)
  expect(() => parseReplyTarget({ ...target, repository: "x/y" }, "acme/widgets")).toThrow()
})
