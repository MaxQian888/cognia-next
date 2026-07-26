import { useChatViewportStore } from "./chat-viewport-store"

beforeEach(() => {
  useChatViewportStore.setState({ activeTurnMessageIds: [], jumpToMessage: null })
})

describe("chatViewportStore", () => {
  it("ignores a write that repeats the turn already published", () => {
    const store = useChatViewportStore
    store.getState().setActiveTurnMessageIds(["m1", "m2"])
    const first = store.getState().activeTurnMessageIds

    store.getState().setActiveTurnMessageIds(["m1", "m2"])

    // Identity has to survive: the publisher re-runs on every scroll frame, and
    // a fresh array each time would re-render the dock's tab strip at 60fps for
    // a value that never changed.
    expect(store.getState().activeTurnMessageIds).toBe(first)
  })

  it("publishes a genuinely different turn", () => {
    const store = useChatViewportStore
    store.getState().setActiveTurnMessageIds(["m1"])
    store.getState().setActiveTurnMessageIds(["m2", "m3"])

    expect(store.getState().activeTurnMessageIds).toEqual(["m2", "m3"])
  })

  it("copies the ids so a caller's array cannot mutate under the subscribers", () => {
    const ids = ["m1"]
    useChatViewportStore.getState().setActiveTurnMessageIds(ids)
    ids.push("m2")

    expect(useChatViewportStore.getState().activeTurnMessageIds).toEqual(["m1"])
  })

  it("registers and clears the message list's jump", () => {
    const jump = jest.fn()
    useChatViewportStore.getState().registerJumpToMessage(jump)
    useChatViewportStore.getState().jumpToMessage?.("m1")
    expect(jump).toHaveBeenCalledWith("m1")

    useChatViewportStore.getState().registerJumpToMessage(null)
    expect(useChatViewportStore.getState().jumpToMessage).toBeNull()
  })

  it("leaves the state untouched when an unregister finds nothing registered", () => {
    const before = useChatViewportStore.getState()
    before.registerJumpToMessage(null)
    expect(useChatViewportStore.getState()).toBe(before)
  })
})
