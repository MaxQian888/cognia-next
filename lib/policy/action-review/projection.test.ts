/** @jest-environment jsdom */
import {
  ACTION_REVIEW_CONTRACT_VERSION,
  type ActionReviewChannel,
  type ActionReviewDecision,
  type ActionReviewRequest,
} from "@cognia/agent-config-types/action-review"
import { createExecutionRun } from "@/lib/db/execution-runs"
import { getActionReviewReceipt } from "@/lib/db/action-review-receipts"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { ExecutionRun } from "@/types/execution/run"
import {
  actionReviewInterruptId,
  projectActionReviewOpened,
  projectActionReviewSettled,
} from "./projection"
import { __resetActionReviewChannelsForTesting } from "./registry"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetActionReviewChannelsForTesting()
})
afterAll(dbFixture.dispose)

const RUN_ID = "run-approval-1"

async function seedRun(): Promise<ExecutionRun> {
  return createExecutionRun({
    id: RUN_ID,
    kind: "agent-turn",
    sourceId: "src-1",
    title: "Turn",
    status: "waiting",
    currentRevision: 0,
    startedAt: 1_000,
    updatedAt: 1_000,
  })
}

function makeRequest(
  overrides: {
    requestId?: string
    channel?: ActionReviewChannel
    runId?: string | undefined
  } = {}
): ActionReviewRequest {
  return {
    contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
    requestId: overrides.requestId ?? "req-1",
    origin: {
      channel: overrides.channel ?? "chat-tool",
      scope: "chat",
      id: "origin-1",
      ...("runId" in overrides ? { runId: overrides.runId } : { runId: RUN_ID }),
    },
    subject: { kind: "tool-call", ref: "Bash", title: "rm -rf /tmp//secret-path" },
    verdict: "ask",
    verdictExplicit: false,
    tier: "high",
    surfaces: [{ id: "native-command", evidence: "Bash" }],
    requestedAt: 2_000,
  }
}

function makeDecision(overrides: Partial<ActionReviewDecision> = {}): ActionReviewDecision {
  return {
    contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
    requestId: "req-1",
    outcome: "allow",
    authority: "human",
    decidedAt: 3_000,
    ...overrides,
  }
}

const interruptRow = (requestId = "req-1") =>
  getDb().executionRunInterrupts.get(actionReviewInterruptId(requestId))

describe("projectActionReviewOpened", () => {
  it("parks the run on a pending interrupt", async () => {
    await seedRun()
    const opened = await projectActionReviewOpened(makeRequest(), 5_000)

    expect(opened).toEqual({ interruptId: actionReviewInterruptId("req-1") })
    expect(await interruptRow()).toMatchObject({
      runId: RUN_ID,
      type: "tool_approval",
      status: "pending",
      title: "Bash",
      toolName: "Bash",
    })
  })

  it("never puts the producer-supplied subject title in the pending row", async () => {
    await seedRun()
    await projectActionReviewOpened(makeRequest(), 5_000)
    expect(JSON.stringify(await interruptRow())).not.toContain("secret-path")
  })

  it("defaults an expiry when the request carries none", async () => {
    await seedRun()
    await projectActionReviewOpened(makeRequest(), 5_000)
    expect((await interruptRow())?.expiresAt).toBe(5_000 + 10 * 60 * 1000)
  })

  it("does nothing for a review that belongs to no run", async () => {
    await seedRun()
    expect(await projectActionReviewOpened(makeRequest({ runId: undefined }))).toBeNull()
    expect(await interruptRow()).toBeUndefined()
  })

  it("does nothing for a receipt-only channel", async () => {
    await seedRun()
    expect(
      await projectActionReviewOpened(makeRequest({ channel: "connector-workflow" }))
    ).toBeNull()
    expect(await interruptRow()).toBeUndefined()
  })

  it("is idempotent — a retried open does not mint a second pending row", async () => {
    await seedRun()
    await projectActionReviewOpened(makeRequest(), 5_000)
    await projectActionReviewOpened(makeRequest(), 6_000)
    expect(await getDb().executionRunInterrupts.count()).toBe(1)
  })

  it("does not throw when the run does not exist", async () => {
    await expect(projectActionReviewOpened(makeRequest())).resolves.toBeNull()
  })
})

describe("projectActionReviewSettled", () => {
  it.each([
    ["allow", "approved"],
    ["allow_always", "approved"],
    ["deny", "denied"],
    ["interrupted", "denied"],
  ] as const)("%s resolves the interrupt as %s", async (outcome, status) => {
    await seedRun()
    await projectActionReviewOpened(makeRequest(), 5_000)
    await projectActionReviewSettled(makeRequest(), makeDecision({ outcome }))
    expect((await interruptRow())?.status).toBe(status)
  })

  it("expires the interrupt on an expired outcome", async () => {
    await seedRun()
    await projectActionReviewOpened(makeRequest(), 5_000)
    await projectActionReviewSettled(
      makeRequest(),
      makeDecision({ outcome: "expired", authority: "timeout" })
    )
    expect((await interruptRow())?.status).toBe("expired")
  })

  it("writes the durable receipt", async () => {
    await seedRun()
    await projectActionReviewSettled(makeRequest(), makeDecision())
    const receipt = await getActionReviewReceipt("req-1")
    expect(receipt).toMatchObject({
      id: "req-1",
      decision: { outcome: "allow", authority: "human" },
    })
  })

  it("stamps the 90-day retention watermark from the decision", async () => {
    await seedRun()
    await projectActionReviewSettled(makeRequest(), makeDecision({ decidedAt: 10_000 }))
    const receipt = await getActionReviewReceipt("req-1")
    expect(receipt?.expiresAt).toBe(10_000 + 90 * 86_400_000)
  })

  it("records a receipt even when the review belonged to no run", async () => {
    await projectActionReviewSettled(makeRequest({ runId: undefined }), makeDecision())
    expect(await getActionReviewReceipt("req-1")).toBeTruthy()
  })

  it("attaches the effect when one is supplied", async () => {
    await seedRun()
    await projectActionReviewSettled(makeRequest(), makeDecision(), {
      status: "executed",
      durationMs: 12,
    })
    expect((await getActionReviewReceipt("req-1"))?.effect).toMatchObject({ status: "executed" })
  })

  it("still writes the receipt when the interrupt projection cannot resolve", async () => {
    // No run seeded, and no interrupt was ever opened.
    await projectActionReviewSettled(makeRequest(), makeDecision())
    expect(await getActionReviewReceipt("req-1")).toBeTruthy()
  })
})
