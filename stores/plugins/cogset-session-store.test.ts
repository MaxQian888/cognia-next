import { useCogsetSessionStore } from "./cogset-session-store"

describe("useCogsetSessionStore", () => {
  it("sets and clears the session override", () => {
    expect(useCogsetSessionStore.getState().overrideCogsetId).toBeUndefined()
    useCogsetSessionStore.getState().setOverride("writing")
    expect(useCogsetSessionStore.getState().overrideCogsetId).toBe("writing")
    useCogsetSessionStore.getState().clearOverride()
    expect(useCogsetSessionStore.getState().overrideCogsetId).toBeUndefined()
  })
})
