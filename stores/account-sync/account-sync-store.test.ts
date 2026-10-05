import { useAccountSyncStore } from "./account-sync-store"

beforeEach(() => useAccountSyncStore.getState().reset())

describe("useAccountSyncStore", () => {
  it("starts idle", () => {
    expect(useAccountSyncStore.getState()).toMatchObject({
      view: { kind: "idle" },
      incoming: [],
      context: null,
      error: null,
    })
  })

  it("applies a look and clears the previous error", () => {
    const store = useAccountSyncStore.getState()
    store.failPoll("offline")
    store.failPoll("offline")
    expect(useAccountSyncStore.getState().error).toEqual({ message: "offline", failures: 2 })
    store.applyPoll({ view: { kind: "signed-out" }, incoming: [] }, null, 5)
    expect(useAccountSyncStore.getState()).toMatchObject({
      view: { kind: "signed-out" },
      lastPolledAt: 5,
      error: null,
    })
  })

  it("opens and closes the approval and asks for a refresh", () => {
    const store = useAccountSyncStore.getState()
    store.openApproval("req_1")
    expect(useAccountSyncStore.getState().approvalRequestId).toBe("req_1")
    store.closeApproval()
    expect(useAccountSyncStore.getState().approvalRequestId).toBeNull()
    store.requestRefresh()
    store.requestRefresh()
    expect(useAccountSyncStore.getState().refreshNonce).toBe(2)
  })

  it("holds the data engine and its status, and forgets the status with the engine", () => {
    const store = useAccountSyncStore.getState()
    const engine = { stop: jest.fn() } as never
    store.setEngine(engine)
    store.setEngineStatus({ kind: "follower" })
    expect(useAccountSyncStore.getState()).toMatchObject({
      engine,
      engineStatus: { kind: "follower" },
    })
    store.setEngine(null)
    expect(useAccountSyncStore.getState()).toMatchObject({ engine: null, engineStatus: null })
  })

  it("opens the join dialog when the engine first asks, and lets it be closed and reopened", () => {
    const store = useAccountSyncStore.getState()
    const asking = {
      kind: "join-choice" as const,
      local: { counts: {} as never, total: 3 },
      remoteSeq: 9,
    }
    store.setEngineStatus(asking)
    expect(useAccountSyncStore.getState().joinDialogOpen).toBe(true)
    store.setJoinDialogOpen(false)
    store.setEngineStatus(asking)
    expect(useAccountSyncStore.getState().joinDialogOpen).toBe(false)
    store.setJoinDialogOpen(true)
    store.setEngineStatus({ kind: "seeding", progress: null })
    expect(useAccountSyncStore.getState().joinDialogOpen).toBe(false)
  })
})
