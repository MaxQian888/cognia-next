/** @jest-environment jsdom */
import { createExecutionRun } from "@/lib/db/execution-runs"
import { getActionReviewReceipt } from "@/lib/db/action-review-receipts"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { actionReviewInterruptId } from "./projection"
import {
  __pendingChatToolReviewCount,
  __resetChatToolReviewsForTesting,
  openChatToolReview,
  recordChatToolApprovalDecision,
  settleChatToolReview,
} from "./chat-tool-channel"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetChatToolReviewsForTesting()
})
afterAll(dbFixture.dispose)

const SESSION = "session-1"
const REQUEST = "req-1"

async function seedRun(status: "running" | "completed" = "running") {
  await createExecutionRun({
    id: "run-1",
    kind: "agent-turn",
    sourceId: "src-1",
    sessionId: SESSION,
    title: "Turn",
    status,
    currentRevision: 0,
    startedAt: 1_000,
    updatedAt: 1_000,
  })
}

const open = (toolName = "Bash") =>
  openChatToolReview({ sessionId: SESSION, requestId: REQUEST, toolName }, 5_000)

const interrupt = () => getDb().executionRunInterrupts.get(actionReviewInterruptId(REQUEST))

describe("openChatToolReview", () => {
  it("parks the session's live run on a pending interrupt", async () => {
    await seedRun()
    await open()
    expect(await interrupt()).toMatchObject({
      runId: "run-1",
      type: "tool_approval",
      status: "pending",
      toolName: "Bash",
    })
  })

  it("classifies risk from the tool, reusing the deterministic classifier", async () => {
    await seedRun()
    await open("Bash")
    await settleChatToolReview(
      { sessionId: SESSION, requestId: REQUEST, outcome: "allow", authority: "human" },
      6_000
    )
    const receipt = await getActionReviewReceipt(REQUEST)
    // `Bash` is a native-command surface, so it must not land as low risk.
    expect(receipt?.request.surfaces.map((s) => s.id)).toContain("native-command")
    expect(receipt?.request.tier).not.toBe("low")
  })

  it("records the ask even when the session has no live run", async () => {
    await seedRun("completed")
    await open()
    expect(await interrupt()).toBeUndefined()
    expect(__pendingChatToolReviewCount()).toBe(1)
  })

  it("never stores the tool arguments on the request", async () => {
    await seedRun()
    await openChatToolReview({ sessionId: SESSION, requestId: REQUEST, toolName: "Bash" }, 5_000)
    await settleChatToolReview(
      { sessionId: SESSION, requestId: REQUEST, outcome: "allow", authority: "human" },
      6_000
    )
    expect((await getActionReviewReceipt(REQUEST))?.request.subject.input).toBeUndefined()
  })
})

describe("settleChatToolReview", () => {
  it("serializes a decision that arrives while the ask is still opening", async () => {
    await seedRun()
    const opening = open()

    await settleChatToolReview(
      { sessionId: SESSION, requestId: REQUEST, outcome: "allow", authority: "human" },
      6_000
    )
    await opening

    expect(__pendingChatToolReviewCount()).toBe(0)
    expect((await getActionReviewReceipt(REQUEST))?.decision.outcome).toBe("allow")
    expect((await interrupt())?.status).toBe("approved")
  })

  it("writes a receipt carrying the stated authority", async () => {
    await seedRun()
    await open()
    await settleChatToolReview(
      {
        sessionId: SESSION,
        requestId: REQUEST,
        outcome: "deny",
        authority: "policy-deny",
        reason: "blocked by plugin",
      },
      6_000
    )
    expect(await getActionReviewReceipt(REQUEST)).toMatchObject({
      decision: { outcome: "deny", authority: "policy-deny", reason: "blocked by plugin" },
    })
    expect((await interrupt())?.status).toBe("denied")
  })

  it("is idempotent, so the modal and the approveTool fallback cannot double-record", async () => {
    await seedRun()
    await open()
    await settleChatToolReview({
      sessionId: SESSION,
      requestId: REQUEST,
      outcome: "allow_always",
      authority: "human",
    })
    await settleChatToolReview({
      sessionId: SESSION,
      requestId: REQUEST,
      outcome: "allow",
      authority: "policy-rule",
    })
    // The first (human) decision stands; the second call is a no-op.
    expect((await getActionReviewReceipt(REQUEST))?.decision).toMatchObject({
      outcome: "allow_always",
      authority: "human",
    })
    expect(__pendingChatToolReviewCount()).toBe(0)
  })

  it("does nothing for an ask it never saw", async () => {
    await settleChatToolReview({
      sessionId: SESSION,
      requestId: "unknown",
      outcome: "allow",
      authority: "human",
    })
    expect(await getActionReviewReceipt("unknown")).toBeUndefined()
  })
})

describe("recordChatToolApprovalDecision", () => {
  it("attributes the decision to a person and preserves allow_always", async () => {
    await seedRun()
    await open()
    await recordChatToolApprovalDecision({ sessionId: SESSION, requestId: REQUEST }, "allow_always")
    expect(await getActionReviewReceipt(REQUEST)).toMatchObject({
      decision: { outcome: "allow_always", authority: "human", actor: { kind: "local-user" } },
    })
  })
})

it("bounds the in-flight map so an unanswered session cannot grow without limit", async () => {
  for (let i = 0; i < 520; i += 1) {
    await openChatToolReview({ sessionId: SESSION, requestId: `r-${i}`, toolName: "Read" }, 5_000)
  }
  expect(__pendingChatToolReviewCount()).toBeLessThanOrEqual(500)
})

it("ignores a repeat capture of the same ask (one frame, many subscribers)", async () => {
  await seedRun()
  await open()
  await open()
  await open()
  expect(__pendingChatToolReviewCount()).toBe(1)
  expect(await getDb().executionRunInterrupts.count()).toBe(1)
})
