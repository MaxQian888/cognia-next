/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  clearEndedFleetHistory,
  clearFleetHistory,
  deleteFleetHistory,
  fleetHistoryId,
  getFleetHistory,
  listFleetHistory,
  mergeHistoryRow,
  pruneFleetHistory,
  reconcileFleetHistory,
  recordFleetHistory,
  type FleetSessionHistoryRow,
} from "./fleet-sessions"
import { getDb } from "./schema"

function row(overrides: Partial<FleetSessionHistoryRow> = {}): FleetSessionHistoryRow {
  return {
    id: fleetHistoryId("claude-code", "s1"),
    agent: "claude-code",
    sessionId: "s1",
    cwd: "/proj",
    projectName: "proj",
    firstPrompt: "do the thing",
    terminalLabel: "Ghostty",
    transcriptPath: "/t.jsonl",
    startedAt: 1000,
    updatedAt: 1000,
    endedAt: null,
    outcome: "active",
    ...overrides,
  }
}

// Cold-opening the versioned CogniaDB at v105 under fake-indexeddb can exceed
// the default 5s per-test timeout on the first DB touch (especially in a full
// batch run); give every test headroom (mirrors captured-items.test.ts).
jest.setTimeout(30_000)

beforeEach(async () => {
  await getDb().fleetSessions.clear()
}, 30_000)

describe("mergeHistoryRow", () => {
  it("returns the incoming row when none exists", () => {
    const r = row()
    expect(mergeHistoryRow(undefined, r)).toBe(r)
  })

  it("keeps sticky first-seen values and never un-ends", () => {
    const existing = row({
      firstPrompt: "original",
      startedAt: 1000,
      endedAt: 5000,
      outcome: "ended",
    })
    const incoming = row({
      firstPrompt: "later",
      startedAt: 9999,
      endedAt: null,
      outcome: "active",
      updatedAt: 8000,
      projectName: "renamed",
    })
    const merged = mergeHistoryRow(existing, incoming)
    expect(merged.firstPrompt).toBe("original")
    expect(merged.startedAt).toBe(1000)
    expect(merged.endedAt).toBe(5000)
    expect(merged.outcome).toBe("ended")
    // Non-sticky fields do update.
    expect(merged.projectName).toBe("renamed")
    expect(merged.updatedAt).toBe(8000)
  })

  it("adopts a first prompt that arrives after the row was created", () => {
    const existing = row({ firstPrompt: null })
    const merged = mergeHistoryRow(existing, row({ firstPrompt: "arrived" }))
    expect(merged.firstPrompt).toBe("arrived")
  })

  it("records an end that arrives on a later update", () => {
    const existing = row({ endedAt: null, outcome: "active" })
    const merged = mergeHistoryRow(existing, row({ endedAt: 7000, outcome: "ended" }))
    expect(merged.endedAt).toBe(7000)
    expect(merged.outcome).toBe("ended")
  })
})

describe("fleet-sessions persistence", () => {
  it("upserts and reads back a row", async () => {
    await recordFleetHistory(row())
    const got = await getFleetHistory("claude-code", "s1")
    expect(got?.projectName).toBe("proj")
  })

  it("preserves first prompt / start across repeated writes", async () => {
    await recordFleetHistory(row({ firstPrompt: "first", startedAt: 1000 }))
    await recordFleetHistory(row({ firstPrompt: "second", startedAt: 2000, updatedAt: 2000 }))
    const got = await getFleetHistory("claude-code", "s1")
    expect(got?.firstPrompt).toBe("first")
    expect(got?.startedAt).toBe(1000)
    expect(got?.updatedAt).toBe(2000)
  })

  it("lists newest first and clears", async () => {
    await recordFleetHistory(
      row({ id: fleetHistoryId("codex", "old"), sessionId: "old", agent: "codex", startedAt: 100 })
    )
    await recordFleetHistory(
      row({ id: fleetHistoryId("codex", "new"), sessionId: "new", agent: "codex", startedAt: 900 })
    )
    const list = await listFleetHistory()
    expect(list.map((r) => r.sessionId)).toEqual(["new", "old"])
    await clearFleetHistory()
    expect(await listFleetHistory()).toEqual([])
  })

  it("deletes a single row by id", async () => {
    await recordFleetHistory(row({ id: "a", sessionId: "a" }))
    await recordFleetHistory(row({ id: "b", sessionId: "b" }))
    await deleteFleetHistory("a")
    const list = await listFleetHistory()
    expect(list.map((r) => r.id)).toEqual(["b"])
    // Deleting a missing id is a harmless no-op.
    await deleteFleetHistory("ghost")
    expect((await listFleetHistory()).length).toBe(1)
  })

  it("clears ended rows and keeps active ones", async () => {
    await recordFleetHistory(row({ id: "live", sessionId: "live", outcome: "active" }))
    await recordFleetHistory(
      row({ id: "done", sessionId: "done", outcome: "ended", endedAt: 2000 })
    )
    await recordFleetHistory(
      row({ id: "done2", sessionId: "done2", outcome: "ended", endedAt: 3000 })
    )
    const removed = await clearEndedFleetHistory()
    expect(removed).toBe(2)
    const list = await listFleetHistory()
    expect(list.map((r) => r.id)).toEqual(["live"])
  })

  it("prunes rows older than a cutoff", async () => {
    await recordFleetHistory(row({ id: "a", sessionId: "a", startedAt: 100 }))
    await recordFleetHistory(row({ id: "b", sessionId: "b", startedAt: 5000 }))
    const removed = await pruneFleetHistory(1000)
    expect(removed).toBe(1)
    const list = await listFleetHistory()
    expect(list.map((r) => r.sessionId)).toEqual(["b"])
  })

  it("detaches active rows missing from an authoritative snapshot", async () => {
    await recordFleetHistory(row({ id: "missing", sessionId: "missing", outcome: "active" }))
    await recordFleetHistory(row({ id: "live", sessionId: "live", outcome: "active" }))
    await recordFleetHistory(
      row({ id: "ended", sessionId: "ended", outcome: "ended", endedAt: 500 })
    )

    await reconcileFleetHistory([row({ id: "live", sessionId: "live", updatedAt: 2_000 })], 2_000)

    expect((await getDb().fleetSessions.get("missing"))?.outcome).toBe("detached")
    expect((await getDb().fleetSessions.get("live"))?.outcome).toBe("active")
    expect((await getDb().fleetSessions.get("ended"))?.outcome).toBe("ended")
  })
})
