import { AUTHOR, fixture, issueComment, NOW, REPOSITORY } from "./comment-bot.test-helpers"
import { sha256Hex, taskRef, type ReplyTarget } from "./command-source"
import { trackingKey } from "./tracking"
import { replyToCommand, threadStatus } from "./reply"

async function target(body: string, over: Partial<ReplyTarget> = {}): Promise<ReplyTarget> {
  return {
    schemaVersion: 1,
    ingress: "webhook",
    repositoryId: "4242",
    repository: REPOSITORY,
    threadKind: "issue",
    threadNumber: 7,
    sourceKind: "issue_comment",
    sourceId: "11",
    sourceRevision: new Date(NOW - 60_000).toISOString(),
    sourceCreatedAt: new Date(NOW - 60_000).toISOString(),
    sourceBodyHash: await sha256Hex(body),
    actor: AUTHOR,
    ...over,
  }
}

async function replyFixture(
  body: string,
  reply: unknown,
  over: Parameters<typeof fixture>[0] = {}
) {
  const t = await target(body)
  const f = fixture({
    triggerId: "reply",
    payload: { schemaVersion: 1, revision: t.sourceRevision, target: t, reply },
    ...over,
  })
  f.github.comments.set(11, issueComment(11, body))
  return f
}

it("posts help as a fixed, marked reply with the trigger only in code", async () => {
  const f = await replyFixture("@cognia-bot help", { kind: "help" })
  await expect(replyToCommand(f.context, f.run, f.config, f.now)).resolves.toMatchObject({
    summary: "Reply published",
  })
  const call = f.mocks.action.mock.calls[0][0] as {
    actionId: string
    input: Record<string, string>
  }
  expect(call.actionId).toBe("commentIssue")
  expect(call.input.body).toMatch(/^\*\*Commands\*\*/)
  expect(call.input.body).toMatch(/<!-- cognia-command:v1:r-11-[0-9a-f]{8}-help -->$/)
  expect(call.input.marker).toMatch(/r-11-[0-9a-f]{8}-help/)
  expect(f.mocks.approval.mock.calls[0][1]).toMatchObject({ decisionMode: "policy" })
})

it("asks a person in approval mode and replies nothing to a deleted, edited or unauthorized command", async () => {
  const human = await replyFixture(
    "@cognia-bot help",
    { kind: "help" },
    { config: { publicationMode: "approval" } }
  )
  await replyToCommand(human.context, human.run, human.config, human.now)
  expect(human.mocks.approval.mock.calls[0][1]).toMatchObject({ decisionMode: "human" })

  const deleted = await replyFixture("@cognia-bot help", { kind: "help" })
  deleted.github.comments.delete(11)
  await expect(
    replyToCommand(deleted.context, deleted.run, deleted.config, deleted.now)
  ).resolves.toMatchObject({
    output: { status: "deleted" },
  })
  const revoked = await replyFixture("@cognia-bot help", { kind: "help" })
  revoked.github.permissions.delete(AUTHOR.login)
  await expect(
    replyToCommand(revoked.context, revoked.run, revoked.config, revoked.now)
  ).resolves.toMatchObject({
    output: { status: "denied" },
  })
  expect(deleted.mocks.action).not.toHaveBeenCalled()
  expect(revoked.mocks.action).not.toHaveBeenCalled()
})

it("replies in the line thread a line-comment command came from", async () => {
  const body = "@cognia-bot fix"
  const t = await target(body, {
    threadKind: "pull_request",
    threadNumber: 8,
    sourceKind: "review_comment",
    sourceId: "12",
  })
  const f = fixture({
    triggerId: "reply",
    payload: {
      schemaVersion: 1,
      revision: t.sourceRevision,
      target: t,
      reply: { kind: "not_enabled", verb: "fix" },
    },
  })
  f.github.reviewComments.set(12, {
    ...issueComment(12, body),
    pull_request_url: `https://api.github.com/repos/${REPOSITORY}/pulls/8`,
  })
  await replyToCommand(f.context, f.run, f.config, f.now)
  expect(f.mocks.action.mock.calls[0][0]).toMatchObject({
    actionId: "replyToReviewComment",
    input: { prNumber: 8, commentId: 12 },
  })
})

it("reports the thread's tasks, newest version first, with result links", async () => {
  const f = await replyFixture("@cognia-bot status", { kind: "status" })
  const push = (id: string, resourceId: string, status: string, runId?: string) =>
    f.deliveries.push({
      id,
      eventId: id,
      triggerId: "execute",
      type: "t",
      status,
      runId,
      resource: { kind: "github_command", id: resourceId },
      receivedAt: NOW,
      attempts: 0,
    })
  push("d1", `${REPOSITORY}#7:issue_comment:1`, "succeeded", "run-1")
  push("d2", `${REPOSITORY}#7:issue_comment:2`, "parked")
  push("d3", `${REPOSITORY}#7:issue_comment:2`, "dismissed")
  push("d4", `${REPOSITORY}#70:issue_comment:3`, "running")
  f.runResults.set("run-1", {
    schemaVersion: 1,
    status: "completed",
    taskRef: "x",
    answerUrl: "https://github.com/a",
  })
  const lines = await threadStatus(f.context, f.run, REPOSITORY, 7)
  expect(lines).toEqual([
    {
      ref: await taskRef(`${REPOSITORY}#7:issue_comment:1`),
      state: "completed",
      url: "https://github.com/a",
    },
    { ref: await taskRef(`${REPOSITORY}#7:issue_comment:2`), state: "waiting" },
  ])
  const one = await threadStatus(f.context, f.run, REPOSITORY, 7, lines[1].ref)
  expect(one).toEqual([lines[1]])
  await replyToCommand(f.context, f.run, f.config, f.now)
  expect((f.mocks.action.mock.calls[0][0] as { input: { body: string } }).input.body).toContain(
    "waiting for approval"
  )
})

it("moves cancelled work's tracking comments to cancelled", async () => {
  const resourceId = `${REPOSITORY}#7:issue_comment:1`
  const f = fixture({
    triggerId: "reply",
    payload: {
      schemaVersion: 1,
      revision: "r",
      repository: REPOSITORY,
      repositoryId: "4242",
      resourceIds: [resourceId, "other/repo#1:x:1"],
    },
  })
  await f.context.storage.set(trackingKey("install", resourceId), {
    commentId: 77,
    marker: "<!-- cognia-command:v1:t-0a1b2c3d-deadbeef -->",
    markerId: "t-0a1b2c3d-deadbeef",
    ref: "0a1b2c3d",
    repository: REPOSITORY,
    phase: "running",
  })
  await replyToCommand(f.context, f.run, f.config, f.now)
  expect(f.mocks.action).toHaveBeenCalledTimes(1)
  expect(f.mocks.action.mock.calls[0][0]).toMatchObject({
    actionId: "updateComment",
    input: { commentId: 77, kind: "issue" },
  })
  expect((f.mocks.action.mock.calls[0][0] as { input: { body: string } }).input.body).toContain(
    "cancelled"
  )
})
