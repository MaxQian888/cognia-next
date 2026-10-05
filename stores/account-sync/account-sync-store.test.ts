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
})
