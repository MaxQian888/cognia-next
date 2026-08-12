import {
  ACTION_REVIEW_CONTRACT_VERSION,
  type ActionReviewReceipt,
} from "@cognia/agent-config-types/action-review"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { getDecisionContext } from "./governance-ledger"
import {
  ACTION_REVIEW_RECEIPT_CAP,
  ACTION_REVIEW_RETENTION_DAYS,
  attachActionReviewEffect,
  clearActionReviewReceipts,
  getActionReviewReceipt,
  listActionReviewReceipts,
  pruneActionReviewReceipts,
  recordActionReviewReceipt,
  toReceiptRow,
} from "./action-review-receipts"

const MS_PER_DAY = 86_400_000

function makeReceipt(
  overrides: {
    id?: string
    decidedAt?: number
    expiresAt?: number
    channel?: ActionReviewReceipt["request"]["origin"]["channel"]
    outcome?: ActionReviewReceipt["decision"]["outcome"]
    authority?: ActionReviewReceipt["decision"]["authority"]
    tier?: ActionReviewReceipt["request"]["tier"]
    sessionId?: string
    runId?: string
    projectId?: string
    surfaces?: ActionReviewReceipt["request"]["surfaces"]
    effect?: ActionReviewReceipt["effect"]
  } = {}
): ActionReviewReceipt {
  const id = overrides.id ?? "req-1"
  const decidedAt = overrides.decidedAt ?? 1_000
  return {
    contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
    id,
    request: {
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      requestId: id,
      origin: {
        channel: overrides.channel ?? "chat-tool",
        scope: "chat",
        id,
        sessionId: overrides.sessionId,
        runId: overrides.runId,
        projectId: overrides.projectId,
      },
      subject: { kind: "tool-call", ref: "Bash" },
      verdict: "ask",
      verdictExplicit: false,
      tier: overrides.tier ?? "medium",
      surfaces: overrides.surfaces ?? [{ id: "native-command", evidence: "bash" }],
      requestedAt: decidedAt - 10,
    },
    decision: {
      contractVersion: ACTION_REVIEW_CONTRACT_VERSION,
      requestId: id,
      outcome: overrides.outcome ?? "allow",
      authority: overrides.authority ?? "human",
      decidedAt,
    },
    effect: overrides.effect,
    expiresAt: overrides.expiresAt ?? 0,
  }
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("toReceiptRow", () => {
  it("flattens the query columns off the nested receipt", () => {
    const row = toReceiptRow(
      makeReceipt({
        decidedAt: 5_000,
        channel: "workflow-step",
        outcome: "deny",
        authority: "policy-deny",
        tier: "high",
        sessionId: "s1",
        runId: "r1",
        projectId: "p1",
        surfaces: [
          { id: "external-send", evidence: "connector_send" },
          { id: "credential-auth", evidence: "keyring" },
        ],
      })
    )
    expect(row).toMatchObject({
      decidedAt: 5_000,
      channel: "workflow-step",
      outcome: "deny",
      authority: "policy-deny",
      tier: "high",
      sessionId: "s1",
      runId: "r1",
      projectId: "p1",
      surfaceIds: ["external-send", "credential-auth"],
    })
  })

  it("derives expiresAt from the retention window when unset", () => {
    const row = toReceiptRow(makeReceipt({ decidedAt: 5_000, expiresAt: 0 }))
    expect(row.expiresAt).toBe(5_000 + ACTION_REVIEW_RETENTION_DAYS * MS_PER_DAY)
  })

  // A receipt minted under a different retention policy must expire on its own
  // terms, not be silently re-dated by whatever this build thinks the window is.
  it("preserves a producer-supplied expiresAt", () => {
    expect(toReceiptRow(makeReceipt({ decidedAt: 5_000, expiresAt: 9_999 })).expiresAt).toBe(9_999)
  })

  it("leaves optional origin columns undefined when absent", () => {
    const row = toReceiptRow(makeReceipt())
    expect(row.sessionId).toBeUndefined()
    expect(row.runId).toBeUndefined()
    expect(row.projectId).toBeUndefined()
  })

  it("emits an empty surfaceIds array when no surface tripped", () => {
    expect(toReceiptRow(makeReceipt({ surfaces: [] })).surfaceIds).toEqual([])
  })
})

describe("recordActionReviewReceipt", () => {
  it("round-trips a receipt", async () => {
    await recordActionReviewReceipt(makeReceipt({ id: "a", decidedAt: 1 }))
    const row = await getActionReviewReceipt("a")
    expect(row?.id).toBe("a")
    expect(row?.request.subject.ref).toBe("Bash")
    expect(row?.decision.authority).toBe("human")
  })

  it("projects every durable review into the cross-domain decision ledger", async () => {
    await recordActionReviewReceipt(
      makeReceipt({
        id: "governed-review",
        channel: "chat-tool",
        outcome: "allow",
        authority: "human",
        sessionId: "session-1",
      })
    )

    await expect(getDecisionContext("action-review:governed-review")).resolves.toMatchObject({
      decision: {
        kind: "tool-authorization",
        resolution: { outcome: "allow", reasonCode: "human" },
        correlation: { sessionId: "session-1", requestId: "governed-review" },
      },
      events: [{ type: "resolved" }],
    })
  })

  it("projects an already-known effect from the durable receipt", async () => {
    await recordActionReviewReceipt(
      makeReceipt({
        id: "governed-effect",
        effect: { status: "executed", completedAt: 123, durationMs: 12 },
      })
    )

    await expect(getDecisionContext("action-review:governed-effect")).resolves.toMatchObject({
      decision: { lifecycle: { state: "executed" } },
      events: expect.arrayContaining([expect.objectContaining({ type: "executed", at: 123 })]),
    })
  })

  it("is idempotent on id — a retried write overwrites rather than duplicating", async () => {
    await recordActionReviewReceipt(makeReceipt({ id: "a", outcome: "allow" }))
    await recordActionReviewReceipt(
      makeReceipt({ id: "a", outcome: "deny", authority: "policy-deny" })
    )
    expect(await getDb().actionReviewReceipts.count()).toBe(1)
    expect((await getActionReviewReceipt("a"))?.outcome).toBe("deny")
  })

  it("returns undefined for an unknown id", async () => {
    expect(await getActionReviewReceipt("nope")).toBeUndefined()
  })

  it("trims the oldest rows past the cap", async () => {
    // Exercised with an injected cap: the real 20 000 would need that many rows
    // in fake-indexeddb, which exceeds the Jest timeout. The trim logic is
    // cap-agnostic, so a small cap proves the same branch.
    for (const i of [1, 2, 3]) {
      await recordActionReviewReceipt(makeReceipt({ id: `r${i}`, decidedAt: i }), 3)
    }
    expect(await getDb().actionReviewReceipts.count()).toBe(3)

    await recordActionReviewReceipt(makeReceipt({ id: "newest", decidedAt: 99 }), 3)

    expect(await getDb().actionReviewReceipts.count()).toBe(3)
    expect(await getActionReviewReceipt("r1")).toBeUndefined()
    expect(await getActionReviewReceipt("r2")).toBeDefined()
    expect(await getActionReviewReceipt("newest")).toBeDefined()
  })

  it("does not trim when the cap is not exceeded", async () => {
    await recordActionReviewReceipt(makeReceipt({ id: "a", decidedAt: 1 }), 10)
    await recordActionReviewReceipt(makeReceipt({ id: "b", decidedAt: 2 }), 10)
    expect(await getDb().actionReviewReceipts.count()).toBe(2)
  })

  it("defaults to the production cap", () => {
    expect(ACTION_REVIEW_RECEIPT_CAP).toBe(20_000)
  })
})

describe("attachActionReviewEffect", () => {
  it("attaches the effect to an existing receipt", async () => {
    await recordActionReviewReceipt(makeReceipt({ id: "a" }))
    await attachActionReviewEffect("a", { status: "executed", detail: "ok", durationMs: 12 })
    expect((await getActionReviewReceipt("a"))?.effect).toEqual({
      status: "executed",
      detail: "ok",
      durationMs: 12,
    })
  })

  // "We never learned what happened" is itself worth seeing in the log, and an
  // audit write must never break the host flow.
  it("is a silent no-op for an unknown id", async () => {
    await expect(attachActionReviewEffect("missing", { status: "failed" })).resolves.toBeUndefined()
    expect(await getDb().actionReviewReceipts.count()).toBe(0)
  })
})

describe("listActionReviewReceipts", () => {
  beforeEach(async () => {
    await recordActionReviewReceipt(
      makeReceipt({
        id: "a",
        decidedAt: 1_000,
        channel: "chat-tool",
        outcome: "allow",
        authority: "human",
        tier: "low",
        sessionId: "s1",
        runId: "r1",
        surfaces: [{ id: "native-command", evidence: "bash" }],
      })
    )
    await recordActionReviewReceipt(
      makeReceipt({
        id: "b",
        decidedAt: 2_000,
        channel: "workflow-step",
        outcome: "deny",
        authority: "policy-deny",
        tier: "high",
        sessionId: "s2",
        runId: "r2",
        surfaces: [{ id: "credential-auth", evidence: "keyring" }],
      })
    )
    await recordActionReviewReceipt(
      makeReceipt({
        id: "c",
        decidedAt: 3_000,
        channel: "chat-tool",
        outcome: "expired",
        authority: "timeout",
        tier: "medium",
        sessionId: "s1",
        surfaces: [],
      })
    )
  })

  it("returns newest-first", async () => {
    expect((await listActionReviewReceipts()).map((r) => r.id)).toEqual(["c", "b", "a"])
  })

  it.each([
    ["channel", { channel: "chat-tool" as const }, ["c", "a"]],
    ["outcome", { outcome: "deny" as const }, ["b"]],
    ["authority", { authority: "timeout" as const }, ["c"]],
    ["tier", { tier: "high" as const }, ["b"]],
    ["sessionId", { sessionId: "s1" }, ["c", "a"]],
    ["runId", { runId: "r2" }, ["b"]],
    ["surfaceId", { surfaceId: "credential-auth" as const }, ["b"]],
    ["since", { since: 2_000 }, ["c", "b"]],
  ])("filters by %s", async (_label, filter, expected) => {
    expect((await listActionReviewReceipts(filter)).map((r) => r.id)).toEqual(expected)
  })

  it("combines filters", async () => {
    const rows = await listActionReviewReceipts({
      channel: "chat-tool",
      sessionId: "s1",
      since: 2_000,
    })
    expect(rows.map((r) => r.id)).toEqual(["c"])
  })

  it("applies a positive limit", async () => {
    expect((await listActionReviewReceipts({ limit: 2 })).map((r) => r.id)).toEqual(["c", "b"])
  })

  it.each([0, -1])("ignores a non-positive limit (%p)", async (limit) => {
    expect(await listActionReviewReceipts({ limit })).toHaveLength(3)
  })
})

describe("pruneActionReviewReceipts", () => {
  it("deletes rows past their own watermark and returns the count", async () => {
    await recordActionReviewReceipt(makeReceipt({ id: "old", decidedAt: 1, expiresAt: 100 }))
    await recordActionReviewReceipt(makeReceipt({ id: "fresh", decidedAt: 2, expiresAt: 10_000 }))

    expect(await pruneActionReviewReceipts(5_000)).toBe(1)
    expect(await getActionReviewReceipt("old")).toBeUndefined()
    expect(await getActionReviewReceipt("fresh")).toBeDefined()
  })

  it("returns 0 when nothing has expired", async () => {
    await recordActionReviewReceipt(makeReceipt({ id: "fresh", expiresAt: 10_000 }))
    expect(await pruneActionReviewReceipts(5_000)).toBe(0)
  })

  it("returns 0 on an empty table", async () => {
    expect(await pruneActionReviewReceipts(5_000)).toBe(0)
  })

  // Each row expires on the terms it was written under, so raising or lowering
  // the retention constant never retroactively re-dates what is on disk.
  it("honours per-row watermarks that disagree with the current constant", async () => {
    await recordActionReviewReceipt(makeReceipt({ id: "shortWindow", decidedAt: 0, expiresAt: 50 }))
    await recordActionReviewReceipt(makeReceipt({ id: "longWindow", decidedAt: 0, expiresAt: 0 }))
    expect(await pruneActionReviewReceipts(100)).toBe(1)
    expect(await getActionReviewReceipt("longWindow")).toBeDefined()
  })
})

describe("clearActionReviewReceipts", () => {
  it("empties the table", async () => {
    await recordActionReviewReceipt(makeReceipt({ id: "a" }))
    await clearActionReviewReceipts()
    expect(await getDb().actionReviewReceipts.count()).toBe(0)
  })
})
