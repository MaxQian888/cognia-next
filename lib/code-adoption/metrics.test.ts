/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"

import { groupRollup, rollup, rollupByModel, rollupByWorkspace } from "./metrics"
import { persistCodeAdoptionTurn } from "./persist"
import type { CodeAdoptionTurnRow } from "./types"

beforeEach(async () => {
  await getDb().codeAdoptionTurns.clear()
}, 30_000)

function turn(overrides: Partial<CodeAdoptionTurnRow>): CodeAdoptionTurnRow {
  return {
    id: overrides.id ?? "s:1",
    runId: 1,
    sessionId: "s",
    workspaceRoot: "/repo",
    agentKind: "in-app",
    model: "opus",
    ts: 0,
    totalFiles: 1,
    totalAdded: 2,
    totalRemoved: 1,
    files: [],
    truncated: false,
    ...overrides,
  }
}

describe("rollup", () => {
  it("sums files/added/removed and counts turns", () => {
    const r = rollup([
      turn({ totalFiles: 2, totalAdded: 5, totalRemoved: 1 }),
      turn({ totalFiles: 1, totalAdded: 3, totalRemoved: 4 }),
    ])
    expect(r).toEqual(expect.objectContaining({ turns: 2, files: 3, added: 8, removed: 5 }))
  })

  it("is zero for no rows", () => {
    expect(rollup([])).toEqual(
      expect.objectContaining({ turns: 0, files: 0, added: 0, removed: 0 })
    )
  })

  it("computes adoption only from finalized Task Workspace decisions", () => {
    const result = rollup([
      turn({
        measurement: "taskWorkspace",
        trackingState: "tracked",
        adoptionState: "partiallyAccepted",
        proposedFiles: 2,
        proposedAdded: 8,
        proposedRemoved: 2,
        acceptedFiles: 1,
        acceptedAdded: 4,
        acceptedRemoved: 1,
      }),
      turn({
        id: "s:2",
        measurement: "taskWorkspace",
        trackingState: "tracked",
        adoptionState: "pending",
        proposedFiles: 1,
        proposedAdded: 100,
        proposedRemoved: 0,
        acceptedFiles: 0,
        acceptedAdded: 0,
        acceptedRemoved: 0,
      }),
      turn({
        id: "s:3",
        measurement: "legacyFingerprint",
        trackingState: "unavailable",
        adoptionState: "notApplicable",
      }),
    ])

    expect(result).toEqual(
      expect.objectContaining({
        proposedLines: 10,
        acceptedLines: 5,
        lineAdoptionRate: 0.5,
        fileAdoptionRate: 0.5,
        pendingTurns: 1,
        unavailableTurns: 1,
      })
    )
  })
})

describe("groupRollup", () => {
  it("buckets rows by key", () => {
    const grouped = groupRollup(
      [turn({ model: "opus", totalAdded: 2 }), turn({ model: "sonnet", totalAdded: 5 })],
      (r) => r.model ?? "unknown"
    )
    expect(grouped.opus.added).toBe(2)
    expect(grouped.sonnet.added).toBe(5)
  })
})

describe("Dexie-backed rollups", () => {
  it("rolls up recent turns by model", async () => {
    await persistCodeAdoptionTurn(turn({ id: "a:1", model: "opus", totalAdded: 2 }))
    await persistCodeAdoptionTurn(turn({ id: "a:2", model: "opus", totalAdded: 3 }))
    await persistCodeAdoptionTurn(turn({ id: "b:1", model: null, totalAdded: 7 }))
    const byModel = await rollupByModel()
    expect(byModel.opus).toEqual(
      expect.objectContaining({ turns: 2, files: 2, added: 5, removed: 2 })
    )
    expect(byModel.unknown.added).toBe(7)
  })

  it("rolls up recent turns by workspace", async () => {
    await persistCodeAdoptionTurn(turn({ id: "a:1", workspaceRoot: "/x", totalFiles: 1 }))
    await persistCodeAdoptionTurn(turn({ id: "a:2", workspaceRoot: "/y", totalFiles: 4 }))
    const byWs = await rollupByWorkspace()
    expect(byWs["/x"].files).toBe(1)
    expect(byWs["/y"].files).toBe(4)
  })
})
