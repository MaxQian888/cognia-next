import { fixture, NOW } from "./comment-bot.test-helpers"
import {
  conversationAction,
  decideWrite,
  executeWrite,
  isRunControlFlow,
  remoteId,
  remoteUrl,
  replyAction,
  type ApprovedWrite,
} from "./write"

const target = {
  repository: "acme/widgets",
  threadKind: "issue" as const,
  threadNumber: 7,
  sourceKind: "issue_comment" as const,
  sourceId: "11",
}
const MARKER = "<!-- cognia-command:v1:a-1 -->"

function write(over: Partial<ApprovedWrite> = {}): ApprovedWrite {
  return {
    step: "answer",
    ...conversationAction(target, `Hi\n\n${MARKER}`, MARKER),
    idempotencyKey: "key",
    title: "title",
    message: "message",
    reconcile: true,
    ...over,
  }
}

it("asks the policy for an exact approval in automatic mode and a person otherwise", async () => {
  const f = fixture()
  const decision = await decideWrite(f.run, f.config, write(), () => NOW)
  expect(decision).toMatchObject({ outcome: "approved", approvalId: "approval" })
  expect(f.mocks.approval).toHaveBeenCalledWith("answer:decision", {
    decisionMode: "policy",
    title: "title",
    message: "message",
    risk: "medium",
    timeoutMs: 7 * 24 * 60 * 60_000,
    detail: {
      repository: "acme/widgets",
      approvedActions: [
        {
          actionId: "commentIssue",
          input: {
            repoFullName: "acme/widgets",
            issueNumber: 7,
            body: `Hi\n\n${MARKER}`,
            marker: MARKER,
            // The intent time, kept across replays, minus clock skew.
            since: new Date(NOW - 5 * 60_000).toISOString(),
          },
        },
      ],
    },
  })
  await decideWrite(f.run, { ...f.config, publicationMode: "approval" }, write({ step: "x" }))
  expect(f.mocks.approval.mock.calls[1][1]).toMatchObject({ decisionMode: "human" })
})

it("never writes without an approval reference, and reports a refusal", async () => {
  const f = fixture()
  f.mocks.approval.mockResolvedValueOnce({ outcome: "approved", decidedAt: NOW } as never)
  await expect(decideWrite(f.run, f.config, write())).rejects.toThrow("approval reference")
  f.mocks.approval.mockResolvedValueOnce({ outcome: "denied", decidedAt: NOW } as never)
  await expect(decideWrite(f.run, f.config, write({ step: "y" }))).resolves.toEqual({
    outcome: "denied",
  })
})

it("executes the brokered action under the approval, once per step", async () => {
  const f = fixture()
  const w = write()
  const decision = await decideWrite(f.run, f.config, w)
  if (decision.outcome !== "approved") throw new Error("expected approval")
  const receipt = await executeWrite(f.context, f.run, w, decision)
  await executeWrite(f.context, f.run, w, decision)
  expect(f.mocks.action).toHaveBeenCalledTimes(1)
  expect(f.mocks.action).toHaveBeenCalledWith({
    integrationId: "github",
    accountId: "",
    binding: { runId: "run", slotId: "github" },
    approval: { interruptId: "approval" },
    actionId: "commentIssue",
    input: decision.input,
    idempotencyKey: "key",
    source: "workflow",
  })
  expect(remoteUrl(receipt.remote)).toMatch(/^https:\/\/github\.com\//)
  expect(remoteId(receipt.remote)).toBe(5001)
  f.mocks.action.mockResolvedValueOnce({ id: "job", status: "failed", error: "boom" } as never)
  await expect(executeWrite(f.context, f.run, write({ step: "z" }), decision)).rejects.toThrow(
    "GitHub write failed: boom"
  )
})

it("replies in the line thread a command came from, otherwise in the conversation", () => {
  expect(
    replyAction(
      { ...target, threadKind: "pull_request", sourceKind: "review_comment" },
      "b",
      MARKER
    )
  ).toEqual({
    actionId: "replyToReviewComment",
    input: { repoFullName: "acme/widgets", prNumber: 7, commentId: 11, body: "b", marker: MARKER },
  })
  expect(
    replyAction({ ...target, threadKind: "pull_request", sourceKind: "review" }, "b", MARKER)
      .actionId
  ).toBe("commentPr")
  expect(replyAction(target, "b", MARKER).actionId).toBe("commentIssue")
})

it("lets the host's park and cancel signals through a broad catch", () => {
  expect(isRunControlFlow(Object.assign(new Error("x"), { name: "BotRunParkedError" }))).toBe(true)
  expect(isRunControlFlow(Object.assign(new Error("x"), { name: "BotRunCancelledError" }))).toBe(
    true
  )
  const aborted = new AbortController()
  aborted.abort()
  expect(isRunControlFlow(new Error("x"), aborted.signal)).toBe(true)
  expect(isRunControlFlow(new Error("x"))).toBe(false)
  expect(remoteUrl({ html_url: "javascript:alert(1)" })).toBeUndefined()
  expect(remoteId({ id: -1 })).toBeUndefined()
})
