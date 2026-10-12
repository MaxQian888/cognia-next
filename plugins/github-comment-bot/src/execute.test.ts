import { AUTHOR, fixture, HEAD, issueComment, NOW, REPOSITORY } from "./comment-bot.test-helpers"
import { sha256Hex, type CommandSourceV1 } from "./command-source"
import { classifyAgentError, executeCommand } from "./execute"

async function commandSource(
  body: string,
  over: Partial<CommandSourceV1> = {}
): Promise<CommandSourceV1> {
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
    verb: "ask",
    request: "why does it crash?",
    aliased: false,
    ...over,
  }
}

async function setup(
  body = "@cognia-bot ask why does it crash?",
  over: Partial<CommandSourceV1> = {},
  options: Parameters<typeof fixture>[0] = {}
) {
  const source = await commandSource(body, over)
  const f = fixture({ payload: { ...source, revision: source.sourceRevision }, ...options })
  f.github.comments.set(11, issueComment(11, body))
  return { f, source, run: () => executeCommand(f.context, f.run, f.config, f.now) }
}

const actions = (f: ReturnType<typeof fixture>) =>
  f.mocks.action.mock.calls.map((call) => (call[0] as { actionId: string }).actionId)

it("answers a question: tracking comment, read-only agent run, exact approval, then the answer", async () => {
  const { f, run } = await setup()
  const result = await run()
  expect(result).toMatchObject({
    summary: "Answer published",
    output: {
      status: "completed",
      answerUrl: expect.stringMatching(/^https:\/\/github\.com\//),
      complete: true,
      // What the run detail shows: the command, the commit and the context budget.
      source: { repository: REPOSITORY, kind: "issue_comment", id: "11" },
      commitSha: "c".repeat(40),
      context: { omitted: {}, truncatedItems: 0, bytes: expect.any(Number) },
    },
  })
  expect(actions(f)).toEqual(["commentIssue", "updateComment", "commentIssue", "updateComment"])
  expect(f.mocks.acquire).toHaveBeenCalledWith({
    kind: "bot-run",
    runId: "run",
    repository: REPOSITORY,
    ref: "c".repeat(40),
    targetRef: "main",
    credentialSlot: "github",
  })
  expect(f.mocks.agent).toHaveBeenCalledWith(
    "claude-code",
    expect.stringContaining("untrusted data"),
    expect.objectContaining({
      runId: "run",
      permissionMode: "acceptEdits",
      invocationId: "attempt-1",
      timeoutMs: 900_000,
    })
  )
  // The model lane is the installation's route; the plugin names no model of its own.
  expect(f.mocks.agent.mock.calls[0][2]).not.toHaveProperty("model")
  const answer = f.mocks.action.mock.calls[2][0] as {
    input: { body: string; marker: string; since: string }
  }
  expect(answer.input.body).toMatch(
    /^Empty input reaches `parse` unchecked\.\n\n<!-- cognia-command:v1:a-[0-9a-f]{8}-[0-9a-f]{8} -->$/
  )
  expect(answer.input.since).toBe(new Date(NOW - 5 * 60_000).toISOString())
  const last = f.mocks.action.mock.calls[3][0] as { input: { body: string } }
  expect(last.input.body).toContain("answered — https://github.com/")
})

it("replays a completed run without running the agent or writing again", async () => {
  const { f, run } = await setup()
  await run()
  const writes = f.mocks.action.mock.calls.length
  await run()
  expect(f.mocks.agent).toHaveBeenCalledTimes(1)
  expect(f.mocks.action.mock.calls.length).toBe(writes)
})

it("publishes nothing to a deleted, edited or unauthorized command, and announces no refusal", async () => {
  const deleted = await setup()
  deleted.f.github.comments.delete(11)
  await expect(deleted.run()).resolves.toMatchObject({
    output: { status: "cancelled", reasonCode: "source_deleted" },
  })
  const edited = await setup()
  edited.f.github.comments.set(11, issueComment(11, "@cognia-bot ask something else"))
  await expect(edited.run()).resolves.toMatchObject({ output: { status: "superseded" } })
  const denied = await setup()
  denied.f.github.permissions.delete(AUTHOR.login)
  await expect(denied.run()).resolves.toMatchObject({
    output: { status: "denied", reasonCode: "not_collaborator" },
  })
  for (const { f } of [deleted, edited, denied]) {
    expect(f.mocks.action).not.toHaveBeenCalled()
    expect(f.mocks.agent).not.toHaveBeenCalled()
  }
})

it("re-checks the author and the command before publishing an approved answer", async () => {
  const { f, run } = await setup()
  f.mocks.approval.mockImplementation(async (name: string) => {
    // Access is revoked while the answer waits for its decision.
    if (name === "answer:decision") f.github.permissions.delete(AUTHOR.login)
    return { outcome: "approved", decidedAt: NOW, approvalId: "approval" }
  })
  await expect(run()).resolves.toMatchObject({ output: { status: "denied" } })
  expect(actions(f)).toEqual(["commentIssue", "updateComment", "updateComment"])
  expect(f.run.log).toHaveBeenCalledWith(
    "warn",
    "Command author lost access before publication",
    expect.anything()
  )
})

it("expires a stale command with a fixed reply in automatic mode", async () => {
  const old = new Date(NOW - 25 * 3_600_000).toISOString()
  const body = "@cognia-bot ask"
  const { f, run } = await setup(body, { sourceRevision: old })
  f.github.comments.set(11, issueComment(11, body, { created_at: old, updated_at: old }))
  await expect(run()).resolves.toMatchObject({ output: { status: "expired" } })
  expect(actions(f)).toEqual(["commentIssue"])
  expect((f.mocks.action.mock.calls[0][0] as { input: { body: string } }).input.body).toContain(
    "older than 24 hours"
  )
  expect(f.mocks.agent).not.toHaveBeenCalled()
})

it.each([
  [
    "a write to the checkout",
    (f: ReturnType<typeof fixture>) =>
      f.mocks.snapshot.mockResolvedValue({
        id: "s",
        runId: "run",
        baseSha: HEAD,
        headSha: HEAD,
        diff: "+x",
        files: [{ path: "a" }],
        capturedAt: NOW,
      } as never),
    "readonly_violation",
  ],
  [
    "a PII block",
    (f: ReturnType<typeof fixture>) =>
      f.mocks.agent.mockRejectedValue(
        new Error("[ctx.agent.runExternalAgent] blocked: content failed the PII redaction gate")
      ),
    "pii_blocked",
  ],
  [
    "a gateway PII refusal",
    (f: ReturnType<typeof fixture>) =>
      f.mocks.agent.mockResolvedValue({
        status: "failed",
        error: "gateway 400 pii_blocked",
        text: "",
      } as never),
    "pii_blocked",
  ],
  [
    "the cost ceiling",
    (f: ReturnType<typeof fixture>) =>
      f.mocks.agent.mockRejectedValue(
        Object.assign(new Error("Bot run spent $1 of its $1.00 cost ceiling"), {
          code: "budget_exceeded",
        })
      ),
    "budget_exceeded",
  ],
  [
    "an uncertain session",
    (f: ReturnType<typeof fixture>) =>
      f.mocks.agent.mockResolvedValue({ status: "recovery_required", text: "" } as never),
    "recovery_required",
  ],
  [
    "an unusable answer",
    (f: ReturnType<typeof fixture>) =>
      f.mocks.agent.mockResolvedValue({ status: "completed", text: "I think so." } as never),
    "invalid_result",
  ],
  [
    "a moved checkout",
    (f: ReturnType<typeof fixture>) =>
      f.mocks.acquire.mockResolvedValue({
        id: "w",
        runId: "run",
        root: "/r",
        origin: "bot-run",
        headRef: "d".repeat(40),
      } as never),
    "target_changed",
  ],
] as const)("blocks publication on %s", async (_label, arrange, reason) => {
  const { f, run } = await setup()
  arrange(f)
  await expect(run()).resolves.toMatchObject({ output: { status: "blocked", reasonCode: reason } })
  expect(actions(f)).toEqual(["commentIssue", "updateComment"])
  expect((f.mocks.action.mock.calls[1][0] as { input: { body: string } }).input.body).toContain(
    "stopped"
  )
})

it("reports a failed agent run without retrying the prompt", async () => {
  const { f, run } = await setup()
  f.mocks.agent.mockResolvedValue({ status: "failed", error: "timeout", text: "" } as never)
  await expect(run()).resolves.toMatchObject({
    output: { status: "failed", reasonCode: "agent_failed" },
  })
  await run()
  expect(f.mocks.agent).toHaveBeenCalledTimes(1)
})

it("marks the tracking comment failed and lets the delivery retry on an unexpected error", async () => {
  const { f, run } = await setup()
  f.mocks.acquire.mockRejectedValueOnce(new Error("clone failed"))
  await expect(run()).rejects.toThrow("clone failed")
  expect(actions(f)).toEqual(["commentIssue", "updateComment"])
})

it("reviews a pull request at its exact head as a comment review, inline only on diff lines", async () => {
  const body = "@cognia-bot review"
  const { f, run } = await setup(body, {
    verb: "review",
    request: "",
    threadKind: "pull_request",
    threadNumber: 8,
  })
  f.mocks.agent.mockResolvedValue({
    status: "completed",
    text: JSON.stringify({
      summary: "One problem. @cognia-bot was not asked to fix it.",
      findings: [
        { path: "src/validate.ts", line: 2, side: "RIGHT", body: "Throws a bare Error" },
        { path: "src/other.ts", line: 9, side: "RIGHT", body: "Unrelated file" },
      ],
    }),
  } as never)
  await expect(run()).resolves.toMatchObject({
    summary: "Review published",
    output: { status: "completed" },
  })
  expect(f.mocks.acquire).toHaveBeenCalledWith(expect.objectContaining({ ref: "refs/pull/8/head" }))
  const review = f.writes().find((write) => write.actionId === "reviewPr")!
  expect(review.input.event).toBe("COMMENT")
  expect(review.input.commitId).toBe(HEAD)
  expect(review.input.comments).toEqual([
    { path: "src/validate.ts", line: 2, side: "RIGHT", body: "Throws a bare Error" },
  ])
  expect(String(review.input.body)).toContain("`src/other.ts:9` Unrelated file")
  // The answer cannot address the Bot.
  expect(String(review.input.body)).toContain("`@cognia-bot` was not asked")
})

it("does not publish a review against a head that moved after review", async () => {
  const { f, run } = await setup("@cognia-bot review", {
    verb: "review",
    request: "",
    threadKind: "pull_request",
    threadNumber: 8,
  })
  f.mocks.agent.mockResolvedValue({ status: "completed", text: '{"summary":"ok"}' } as never)
  f.mocks.approval.mockImplementation(async (name: string) => {
    if (name === "answer:decision") {
      const pr = f.github.items.get(8)!
      f.github.items.set(8, { ...pr, head: { ...(pr.head as object), sha: "e".repeat(40) } })
    }
    return { outcome: "approved", decidedAt: NOW, approvalId: "approval" }
  })
  await expect(run()).resolves.toMatchObject({
    output: { status: "blocked", reasonCode: "target_changed" },
  })
  expect(actions(f)).not.toContain("reviewPr")
})

it("in approval mode posts no progress and publishes only what a person approved", async () => {
  const { f, run } = await setup(undefined, {}, { config: { publicationMode: "approval" } })
  f.mocks.approval.mockResolvedValue({ outcome: "denied", decidedAt: NOW } as never)
  await expect(run()).resolves.toMatchObject({
    output: { status: "cancelled", reasonCode: "approval_denied" },
  })
  expect(f.mocks.action).not.toHaveBeenCalled()
  expect(f.mocks.approval.mock.calls.map((call) => call[1].decisionMode)).toEqual(["human"])
})

it("notes a partial view and the fix command on an aliased question", async () => {
  const { f, run } = await setup("@cognia-bot what changed?", {
    aliased: true,
    request: "what changed?",
  })
  await run()
  const answer = f.mocks.action.mock.calls[2][0] as { input: { body: string } }
  expect(answer.input.body).toContain("`fix` will be the command")
})

it("classifies agent verdicts that must not be retried", () => {
  expect(classifyAgentError("content failed the PII redaction gate")).toBe("pii_blocked")
  expect(classifyAgentError("upstream pii_blocked")).toBe("pii_blocked")
  expect(classifyAgentError("exceeded its cost ceiling")).toBe("budget_exceeded")
  expect(classifyAgentError("ECONNRESET")).toBeUndefined()
})

it("refuses a payload that is not this repository's ask or review", async () => {
  const { f } = await setup()
  f.run.event.payload = { ...(f.run.event.payload as object), verb: "status" }
  await expect(executeCommand(f.context, f.run, f.config, f.now)).rejects.toThrow(
    "Only ask and review"
  )
  f.run.event.payload = { ...(f.run.event.payload as object), repository: "other/repo" }
  await expect(executeCommand(f.context, f.run, f.config, f.now)).rejects.toThrow("out-of-scope")
})
