/** @jest-environment jsdom */
import {
  useApprovalJournalStore,
  toPersistedApproval,
  markUnsettledInterrupted,
  migrateApprovalJournal,
  stampNotified,
  unannouncedInterrupted,
  type PersistedApproval,
} from "./approval-journal-store"
import type { PendingApproval } from "@cognia/agent-config-types"

function reset() {
  useApprovalJournalStore.setState({ entries: [] })
}

const entry = (over: Partial<PersistedApproval> = {}): Omit<PersistedApproval, "status"> => ({
  requestId: "req-1",
  sessionId: "eph-1",
  bucketSessionId: "chat-1",
  toolName: "Bash",
  requestedAt: 1000,
  ...over,
})

beforeEach(reset)

describe("approval journal store", () => {
  it("records a pending ask (deduped by requestId, FIFO-capped)", () => {
    const s = useApprovalJournalStore.getState()
    s.record(entry())
    s.record(entry()) // same requestId replaces
    expect(useApprovalJournalStore.getState().entries).toEqual([
      expect.objectContaining({ requestId: "req-1", status: "pending" }),
    ])
  })

  it("settle removes the entry; interrupt marks it interrupted", () => {
    const s = useApprovalJournalStore.getState()
    s.record(entry())
    s.interrupt("req-1", "app restarted")
    expect(useApprovalJournalStore.getState().entries[0]).toMatchObject({
      status: "interrupted",
      interruptReason: "app restarted",
    })
    s.settle("req-1")
    expect(useApprovalJournalStore.getState().entries).toEqual([])
  })

  it("caps the journal at 100 entries (FIFO)", () => {
    const s = useApprovalJournalStore.getState()
    for (let i = 0; i < 120; i++) s.record(entry({ requestId: `req-${i}` }))
    const entries = useApprovalJournalStore.getState().entries
    expect(entries).toHaveLength(100)
    expect(entries[0].requestId).toBe("req-20")
    expect(entries.at(-1)?.requestId).toBe("req-119")
  })

  it("dismiss removes an entry", () => {
    const s = useApprovalJournalStore.getState()
    s.record(entry())
    s.dismiss("req-1")
    expect(useApprovalJournalStore.getState().entries).toEqual([])
  })

  it("clearSettled drops only settled entries", () => {
    useApprovalJournalStore.setState({
      entries: [
        { ...entry({ requestId: "a" }), status: "pending" },
        { ...entry({ requestId: "b" }), status: "settled" },
        { ...entry({ requestId: "c" }), status: "interrupted" },
      ],
    })
    useApprovalJournalStore.getState().clearSettled()
    expect(useApprovalJournalStore.getState().entries.map((e) => e.requestId)).toEqual(["a", "c"])
  })
})

describe("persist rehydration", () => {
  it("rehydrates from localStorage and marks restored asks interrupted", async () => {
    window.localStorage.setItem(
      "cognia-approval-journal",
      JSON.stringify({
        version: 1,
        state: { entries: [{ ...entry({ requestId: "restored" }), status: "pending" }] },
      })
    )
    await useApprovalJournalStore.persist.rehydrate()
    const restored = useApprovalJournalStore
      .getState()
      .entries.find((e) => e.requestId === "restored")
    expect(restored?.status).toBe("interrupted")
    window.localStorage.clear()
    reset()
  })
})

describe("rehydrate + migrate helpers", () => {
  it("markUnsettledInterrupted flips pending/settled rows to interrupted", () => {
    const out = markUnsettledInterrupted([
      { ...entry({ requestId: "a" }), status: "pending" },
      { ...entry({ requestId: "b" }), status: "interrupted" },
    ])
    expect(out.every((e) => e.status === "interrupted")).toBe(true)
    // The already-interrupted entry is returned by reference (unchanged).
    expect(out[1]).toMatchObject({ requestId: "b" })
  })

  it("migrateApprovalJournal stamps legacy rows interrupted and tolerates undefined", () => {
    expect(migrateApprovalJournal({ entries: [{ requestId: "x" }] }).entries[0].status).toBe(
      "interrupted"
    )
    expect(migrateApprovalJournal(undefined).entries).toEqual([])
  })
})

describe("toPersistedApproval", () => {
  it("projects a subagent-origin approval with its metadata", () => {
    const approval: PendingApproval = {
      sessionId: "eph-1",
      requestId: "req-1",
      toolUseID: "tu-1",
      toolName: "Bash",
      input: {},
      requestedAt: 5000,
      origin: "subagent",
      subagentId: "explore",
      subagentRunId: "run-1",
    }
    expect(toPersistedApproval(approval, "chat-1")).toEqual({
      requestId: "req-1",
      sessionId: "eph-1",
      bucketSessionId: "chat-1",
      toolName: "Bash",
      requestedAt: 5000,
      origin: "subagent",
      subagentId: "explore",
      subagentRunId: "run-1",
    })
  })

  it("stamps requestedAt when the approval lacks one", () => {
    const approval: PendingApproval = {
      sessionId: "s",
      requestId: "r",
      toolUseID: "t",
      toolName: "Read",
      input: {},
    }
    expect(toPersistedApproval(approval, "chat-1").requestedAt).toEqual(expect.any(Number))
  })
})

describe("announce-once bookkeeping", () => {
  it("unannouncedInterrupted keeps only interrupted rows without a notifiedAt stamp", () => {
    const rows: PersistedApproval[] = [
      { ...entry({ requestId: "new" }), status: "interrupted" },
      { ...entry({ requestId: "told" }), status: "interrupted", notifiedAt: 5 },
      { ...entry({ requestId: "live" }), status: "pending" },
    ]
    expect(unannouncedInterrupted(rows).map((e) => e.requestId)).toEqual(["new"])
  })

  it("markNotified stamps once, keeps the entry listed, and never overwrites a stamp", () => {
    const s = useApprovalJournalStore.getState()
    s.record(entry({ requestId: "a" }))
    s.record(entry({ requestId: "b" }))
    s.interrupt("a")
    s.markNotified(["a"], 100)
    s.markNotified(["a", "b"], 200)
    const byId = new Map(useApprovalJournalStore.getState().entries.map((e) => [e.requestId, e]))
    expect(byId.get("a")).toMatchObject({ status: "interrupted", notifiedAt: 100 })
    expect(byId.get("b")?.notifiedAt).toBe(200)
    expect(stampNotified([], ["x"], 1)).toEqual([])
  })

  it("the stamp survives a relaunch (rehydrate + interrupt marking)", async () => {
    window.localStorage.setItem(
      "cognia-approval-journal",
      JSON.stringify({
        version: 1,
        state: {
          entries: [
            { ...entry({ requestId: "told" }), status: "interrupted", notifiedAt: 7 },
            { ...entry({ requestId: "new" }), status: "pending" },
          ],
        },
      })
    )
    await useApprovalJournalStore.persist.rehydrate()
    const entries = useApprovalJournalStore.getState().entries
    expect(unannouncedInterrupted(entries).map((e) => e.requestId)).toEqual(["new"])
    expect(entries.find((e) => e.requestId === "told")?.notifiedAt).toBe(7)
    // The legacy migration path keeps it too.
    expect(
      migrateApprovalJournal({ entries: [{ requestId: "m", notifiedAt: 3 }] }).entries[0]
    ).toMatchObject({ status: "interrupted", notifiedAt: 3 })
    window.localStorage.clear()
    reset()
  })
})
