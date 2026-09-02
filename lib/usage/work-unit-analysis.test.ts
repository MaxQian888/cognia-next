// Work-unit metrics. The tests that matter are the ones about missing
// evidence: a metric with no input reports null and names the gap, never a
// zero that reads like a measurement.

import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import type { SessionUsageRow } from "@/lib/db/session-usage"

import {
  analyzeWorkUnit,
  classifyWorkUnit,
  groupLogicalTurns,
  groupWorkUnits,
  WORK_UNIT_ANALYSIS_VERSION,
} from "./work-unit-analysis"

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
    costUsd: 2,
    durationMs: 0,
    costSource: "sdk",
    costKnown: true,
    surface: "chat",
    ...over,
  }
}

function adoptionRow(over: Partial<CodeAdoptionTurnRow> = {}): CodeAdoptionTurnRow {
  return {
    id: "s1:1",
    runId: 1,
    sessionId: "s1",
    workspaceRoot: "/repo",
    agentKind: "in-app",
    model: "test-model",
    ts: T0,
    totalFiles: 2,
    totalAdded: 30,
    totalRemoved: 10,
    files: [
      { path: "a.ts", added: 20, removed: 5, isNew: false, hunks: [] },
      { path: "b.ts", added: 10, removed: 5, isNew: true, hunks: [] },
    ],
    truncated: false,
    ...over,
  }
}

describe("classifyWorkUnit", () => {
  it("is unknown for nothing at all, never a guess", () => {
    expect(classifyWorkUnit({ rows: [] })).toBe("unknown")
  })

  it("calls a mostly-delegated unit orchestration", () => {
    const rows = [
      row({ messageId: "a", surface: "subagent" }),
      row({ messageId: "b", surface: "agent-team" }),
      row({ messageId: "c", surface: "chat" }),
    ]
    expect(classifyWorkUnit({ rows })).toBe("delegate")
  })

  it("calls non-conversational metered work a chore", () => {
    const rows = [row({ surface: "embedding" }), row({ messageId: "b", surface: "ocr" })]
    expect(classifyWorkUnit({ rows })).toBe("chore")
  })

  it("trusts adoption evidence over the tool mix", () => {
    expect(
      classifyWorkUnit({ rows: [row()], adoption: [adoptionRow()], toolCounts: { Read: 40 } })
    ).toBe("edit")
  })

  it("calls a shell-heavy edit loop debugging", () => {
    expect(classifyWorkUnit({ rows: [row()], toolCounts: { Edit: 2, Bash: 12 } })).toBe("debug")
  })

  it("calls a plain edit an edit", () => {
    expect(classifyWorkUnit({ rows: [row()], toolCounts: { Edit: 6, Bash: 2, Read: 9 } })).toBe(
      "edit"
    )
  })

  it("calls read-only work exploration", () => {
    expect(classifyWorkUnit({ rows: [row()], toolCounts: { Read: 9, Grep: 4 } })).toBe("explore")
  })

  it("stays unknown when no tools were observed and nothing was written", () => {
    expect(classifyWorkUnit({ rows: [row()] })).toBe("unknown")
  })
})

describe("groupLogicalTurns", () => {
  it("returns null when the rows carry no turn identity", () => {
    // The honest answer for an imported transcript. "0 retries" would be a
    // measurement claim about data that cannot support one.
    expect(groupLogicalTurns([row(), row({ messageId: "b" })])).toBeNull()
  })

  it("groups attempts of the same turn together", () => {
    const groups = groupLogicalTurns([
      row({ messageId: "a", runId: "r1", turnId: "t1", attemptId: "1" }),
      row({ messageId: "b", runId: "r1", turnId: "t1", attemptId: "2" }),
      row({ messageId: "c", runId: "r1", turnId: "t2", attemptId: "1" }),
    ])
    expect(groups?.size).toBe(2)
  })

  it("keeps an identity-less row as its own turn rather than merging them", () => {
    const groups = groupLogicalTurns([
      row({ messageId: "a", runId: "r1", turnId: "t1" }),
      row({ messageId: "b" }),
      row({ messageId: "c" }),
    ])
    expect(groups?.size).toBe(3)
  })
})

describe("analyzeWorkUnit", () => {
  it("stamps the analysis version so a detector bump can invalidate itself", () => {
    expect(analyzeWorkUnit({ rows: [row()] }).analysisVersion).toBe(WORK_UNIT_ANALYSIS_VERSION)
  })

  it("counts retries and the spend they consumed", () => {
    const metrics = analyzeWorkUnit({
      rows: [
        row({ messageId: "a", runId: "r", turnId: "t1", attemptId: "1", at: T0, costUsd: 3 }),
        row({ messageId: "b", runId: "r", turnId: "t1", attemptId: "2", at: T0 + 1, costUsd: 4 }),
        row({ messageId: "c", runId: "r", turnId: "t2", attemptId: "1", at: T0 + 2, costUsd: 5 }),
      ],
      resolve: flatPricing,
    })
    expect(metrics.turns).toBe(3)
    expect(metrics.logicalTurns).toBe(2)
    expect(metrics.retries).toBe(1)
    expect(metrics.oneShotRate).toBeCloseTo(0.5)
    // Only the SUPERSEDED attempt is waste. The last one produced the result.
    expect(metrics.retryCostUsd).toBeCloseTo(3)
  })

  it("reports retry metrics as null and names the gap when identity is absent", () => {
    const metrics = analyzeWorkUnit({ rows: [row(), row({ messageId: "b" })] })
    expect(metrics.retries).toBeNull()
    expect(metrics.oneShotRate).toBeNull()
    expect(metrics.retryCostUsd).toBeNull()
    expect(metrics.gaps).toContain("noAttemptIdentity")
  })

  it("measures cache efficiency against every prompt token class", () => {
    const metrics = analyzeWorkUnit({
      rows: [row({ inputTokens: 100, cacheReadTokens: 300, cacheCreationTokens: 100 })],
    })
    expect(metrics.cacheEfficiency).toBeCloseTo(0.6)
  })

  it("has no cache efficiency for a unit with no prompt at all", () => {
    expect(
      analyzeWorkUnit({
        rows: [row({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })],
      }).cacheEfficiency
    ).toBeNull()
  })

  it("measures how much of the unit ran in delegated agents", () => {
    const metrics = analyzeWorkUnit({
      rows: [row({ surface: "subagent" }), row({ messageId: "b", surface: "chat" })],
    })
    expect(metrics.delegationRate).toBeCloseTo(0.5)
  })

  it("counts model switches in time order, not in row order", () => {
    const metrics = analyzeWorkUnit({
      rows: [
        row({ messageId: "c", at: T0 + 2, model: "a" }),
        row({ messageId: "a", at: T0, model: "a" }),
        row({ messageId: "b", at: T0 + 1, model: "b" }),
      ],
    })
    expect(metrics.modelSwitches).toBe(2)
    expect(metrics.distinctModels).toBe(2)
  })

  it("reports edit metrics from adoption evidence, deduplicating files", () => {
    const metrics = analyzeWorkUnit({
      rows: [row({ costUsd: 8 })],
      adoption: [adoptionRow(), adoptionRow({ id: "s1:2", runId: 2 })],
      resolve: flatPricing,
    })
    expect(metrics.editedFiles).toBe(2)
    expect(metrics.addedLines).toBe(60)
    expect(metrics.costPerEditedFileUsd).toBeCloseTo(4)
  })

  it("reports edit metrics as null and names the gap with no adoption evidence", () => {
    const metrics = analyzeWorkUnit({ rows: [row()] })
    expect(metrics.editedFiles).toBeNull()
    expect(metrics.costPerEditedFileUsd).toBeNull()
    expect(metrics.gaps).toContain("noAdoptionEvidence")
  })

  it("names the pricing gap when nothing in the unit could be priced", () => {
    const metrics = analyzeWorkUnit({
      rows: [row({ costSource: "unknown", costKnown: false, costUsd: 0 })],
    })
    expect(metrics.knownCostUsd).toBe(0)
    expect(metrics.unpricedTurns).toBe(1)
    expect(metrics.gaps).toContain("noPricing")
  })

  it("measures the unit's wall-clock span", () => {
    const metrics = analyzeWorkUnit({
      rows: [row({ at: T0 }), row({ messageId: "b", at: T0 + 60_000 })],
    })
    expect(metrics.durationSeconds).toBe(60)
  })

  it("survives an empty unit", () => {
    const metrics = analyzeWorkUnit({ rows: [] })
    expect(metrics.turns).toBe(0)
    expect(metrics.taskClass).toBe("unknown")
    expect(metrics.durationSeconds).toBe(0)
  })
})

describe("groupWorkUnits", () => {
  it("folds a spawned child run into its parent unit", () => {
    const units = groupWorkUnits([
      row({ messageId: "a", runId: "run-1", sessionId: "s1" }),
      row({ messageId: "b", runId: "run-1", sessionId: "team:run-1", surface: "agent-team" }),
    ])
    expect(units.size).toBe(1)
    expect(units.get("run-1")).toHaveLength(2)
  })

  it("falls back to the session when a row carries no run", () => {
    const units = groupWorkUnits([
      row({ sessionId: "s1" }),
      row({ messageId: "b", sessionId: "s2" }),
    ])
    expect([...units.keys()].sort()).toEqual(["s1", "s2"])
  })
})
