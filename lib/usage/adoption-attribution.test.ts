// Joining spend to outcome. Every test here is really about one rule: an
// absence of evidence is never evidence of rejection, and the module refuses
// to let a caller reach that verdict by accident.

import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import type { SessionUsageRow } from "@/lib/db/session-usage"

import {
  attributeSpend,
  bucketForState,
  canJudgeWaste,
  foldConfidence,
  rowConfidence,
} from "./adoption-attribution"

const T0 = new Date(2026, 5, 5, 12, 0, 0).getTime()
const flatPricing = () => ({ promptPer1M: 1000, completionPer1M: 2000 })

function row(over: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: "m1",
    sessionId: "s1",
    at: T0,
    model: "test-model",
    providerId: "acme",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 10,
    durationMs: 0,
    costSource: "sdk",
    costKnown: true,
    ...over,
  }
}

function adoption(over: Partial<CodeAdoptionTurnRow> = {}): CodeAdoptionTurnRow {
  return {
    id: "s1:1",
    runId: 1,
    sessionId: "s1",
    workspaceRoot: "/repo",
    agentKind: "in-app",
    model: "test-model",
    ts: T0,
    totalFiles: 1,
    totalAdded: 20,
    totalRemoved: 5,
    files: [{ path: "a.ts", added: 20, removed: 5, isNew: false, hunks: [] }],
    truncated: false,
    measurement: "taskWorkspace",
    adoptionState: "accepted",
    acceptedFiles: 1,
    acceptedAdded: 20,
    acceptedRemoved: 5,
    ...over,
  }
}

describe("rowConfidence", () => {
  it("trusts the Task Workspace ledger as a measurement", () => {
    expect(rowConfidence(adoption())).toBe("measured")
  })

  it("calls the older fingerprint tracker heuristic", () => {
    expect(rowConfidence(adoption({ measurement: "legacyFingerprint" }))).toBe("heuristic")
  })

  it("calls a row from before either tracker unknown", () => {
    expect(rowConfidence(adoption({ measurement: undefined }))).toBe("unknown")
  })
})

describe("foldConfidence", () => {
  it("is only as strong as the weakest input", () => {
    expect(foldConfidence(["measured", "heuristic"])).toBe("heuristic")
    expect(foldConfidence(["measured", "unknown"])).toBe("unknown")
    expect(foldConfidence(["measured", "measured"])).toBe("measured")
  })

  it("is unknown for no evidence at all", () => {
    expect(foldConfidence([])).toBe("unknown")
  })
})

describe("bucketForState", () => {
  it("maps the four terminal states", () => {
    expect(bucketForState("accepted")).toBe("acceptedUsd")
    expect(bucketForState("partiallyAccepted")).toBe("partiallyAcceptedUsd")
    expect(bucketForState("rejected")).toBe("rejectedUsd")
    expect(bucketForState("reverted")).toBe("revertedUsd")
  })

  it("refuses to bucket a state that means 'we do not know yet'", () => {
    // Calling an unfinished review a rejection makes every long task look
    // wasteful the moment it is measured.
    expect(bucketForState("pending")).toBeNull()
    expect(bucketForState("unavailable")).toBeNull()
    expect(bucketForState("notApplicable")).toBeNull()
    expect(bucketForState(undefined)).toBeNull()
  })
})

describe("attributeSpend", () => {
  it("buckets a fully accepted session's spend", () => {
    const result = attributeSpend({
      rows: [row()],
      adoption: [adoption()],
      resolve: flatPricing,
    })
    expect(result.spend.acceptedUsd).toBeCloseTo(10)
    expect(result.evidenceCoverage).toBe(1)
    expect(result.confidence).toBe("measured")
  })

  it("leaves a session with no adoption row unattributed, never rejected", () => {
    const result = attributeSpend({ rows: [row()], adoption: [], resolve: flatPricing })
    expect(result.spend.unattributedUsd).toBeCloseTo(10)
    expect(result.spend.rejectedUsd).toBe(0)
    expect(result.evidenceCoverage).toBe(0)
    expect(result.confidence).toBe("unknown")
  })

  it("leaves a pending review unattributed too", () => {
    const result = attributeSpend({
      rows: [row()],
      adoption: [adoption({ adoptionState: "pending" })],
      resolve: flatPricing,
    })
    expect(result.spend.unattributedUsd).toBeCloseTo(10)
  })

  it("spreads a session that ended in more than one state", () => {
    const result = attributeSpend({
      rows: [row()],
      adoption: [
        adoption({ id: "s1:1", adoptionState: "accepted" }),
        adoption({ id: "s1:2", runId: 2, adoptionState: "rejected" }),
      ],
      resolve: flatPricing,
    })
    expect(result.spend.acceptedUsd).toBeCloseTo(5)
    expect(result.spend.rejectedUsd).toBeCloseTo(5)
  })

  it("reports coverage when only part of the window is instrumented", () => {
    const result = attributeSpend({
      rows: [row({ sessionId: "s1" }), row({ messageId: "m2", sessionId: "s2" })],
      adoption: [adoption({ sessionId: "s1" })],
      resolve: flatPricing,
    })
    expect(result.evidenceCoverage).toBeCloseTo(0.5)
    expect(result.sessions).toBe(2)
    expect(result.sessionsWithEvidence).toBe(1)
  })

  it("computes cost per accepted file and line", () => {
    const result = attributeSpend({
      rows: [row()],
      adoption: [adoption()],
      resolve: flatPricing,
    })
    expect(result.costPerAcceptedFileUsd).toBeCloseTo(10)
    expect(result.costPerAcceptedLineUsd).toBeCloseTo(10 / 25)
  })

  it("returns null rather than Infinity when nothing was accepted", () => {
    const result = attributeSpend({
      rows: [row()],
      adoption: [
        adoption({
          adoptionState: "rejected",
          acceptedFiles: 0,
          acceptedAdded: 0,
          acceptedRemoved: 0,
        }),
      ],
      resolve: flatPricing,
    })
    expect(result.costPerAcceptedFileUsd).toBeNull()
    expect(result.costPerAcceptedLineUsd).toBeNull()
  })

  it("counts an unpriceable turn separately rather than as free accepted work", () => {
    const result = attributeSpend({
      rows: [row({ costSource: "unknown", costKnown: false, costUsd: 0 })],
      adoption: [adoption()],
      resolve: flatPricing,
    })
    expect(result.spend.unpricedTurns).toBe(1)
    expect(result.knownCostUsd).toBe(0)
    expect(result.spend.acceptedUsd).toBe(0)
  })

  it("degrades confidence when any joined row was only inferred", () => {
    const result = attributeSpend({
      rows: [row()],
      adoption: [adoption({ measurement: "legacyFingerprint" })],
      resolve: flatPricing,
    })
    expect(result.confidence).toBe("heuristic")
  })

  it("ignores adoption rows for sessions outside the window", () => {
    const result = attributeSpend({
      rows: [row({ sessionId: "s1" })],
      adoption: [adoption({ sessionId: "elsewhere", acceptedFiles: 99 })],
      resolve: flatPricing,
    })
    expect(result.acceptedFiles).toBe(0)
    expect(result.spend.unattributedUsd).toBeCloseTo(10)
  })

  it("survives an empty window", () => {
    const result = attributeSpend({ rows: [], adoption: [], resolve: flatPricing })
    expect(result.knownCostUsd).toBe(0)
    expect(result.evidenceCoverage).toBe(0)
  })
})

describe("canJudgeWaste", () => {
  const base = attributeSpend({
    rows: [row()],
    adoption: [adoption()],
    resolve: flatPricing,
  })

  it("allows a verdict on a measured, well-covered window", () => {
    expect(canJudgeWaste(base)).toBe(true)
  })

  it("refuses a verdict on heuristic evidence", () => {
    expect(canJudgeWaste({ ...base, confidence: "heuristic" })).toBe(false)
  })

  it("refuses a verdict on an external session, which is always unknown", () => {
    expect(canJudgeWaste({ ...base, confidence: "unknown" })).toBe(false)
  })

  it("refuses a verdict when most of the window has no evidence", () => {
    expect(canJudgeWaste({ ...base, evidenceCoverage: 0.2 })).toBe(false)
  })
})
