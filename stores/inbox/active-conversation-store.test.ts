/** @jest-environment jsdom */

import { useActiveConversationStore, isViewingConversation } from "./active-conversation-store"

beforeEach(() => {
  useActiveConversationStore.setState({
    activeConversationKey: null,
    activeSessionId: null,
    visiblePanes: {},
  })
})

describe("active-conversation-store", () => {
  it("sets and clears the active conversation", () => {
    useActiveConversationStore.getState().setActiveConversation("conv:1")
    expect(useActiveConversationStore.getState().activeConversationKey).toBe("conv:1")
    useActiveConversationStore.getState().setActiveConversation(null)
    expect(useActiveConversationStore.getState().activeConversationKey).toBeNull()
  })

  it("clearIf only clears the matching key", () => {
    useActiveConversationStore.getState().setActiveConversation("conv:1")
    useActiveConversationStore.getState().clearIf("conv:2")
    expect(useActiveConversationStore.getState().activeConversationKey).toBe("conv:1")
    useActiveConversationStore.getState().clearIf("conv:1")
    expect(useActiveConversationStore.getState().activeConversationKey).toBeNull()
  })
})

describe("isViewingConversation", () => {
  const original = document.hasFocus

  afterEach(() => {
    document.hasFocus = original
  })

  it("true when focused and the key matches", () => {
    document.hasFocus = () => true
    useActiveConversationStore.getState().setActiveConversation("conv:1")
    expect(isViewingConversation("conv:1")).toBe(true)
  })

  it("false when the key does not match", () => {
    document.hasFocus = () => true
    useActiveConversationStore.getState().setActiveConversation("conv:2")
    expect(isViewingConversation("conv:1")).toBe(false)
  })

  it("false when the window is not focused", () => {
    document.hasFocus = () => false
    useActiveConversationStore.getState().setActiveConversation("conv:1")
    expect(isViewingConversation("conv:1")).toBe(false)
  })
})
/** @jest-environment jsdom */

it("distinguishes an older session from the active runtime session in one remote conversation", () => {
  useActiveConversationStore.getState().setActiveConversation("same", "old")
  const focus = jest.spyOn(document, "hasFocus").mockReturnValue(true)
  expect(isViewingConversation("same", "old")).toBe(true)
  expect(isViewingConversation("same", "new")).toBe(false)
  useActiveConversationStore.getState().clearIf("same", "new")
  expect(isViewingConversation("same", "old")).toBe(true)
  useActiveConversationStore.getState().clearIf("same")
  expect(useActiveConversationStore.getState().activeSessionId).toBeNull()
  focus.mockRestore()
})

it("tracks multiple visible exact sessions independently of active focus", () => {
  jest.spyOn(document, "hasFocus").mockReturnValue(true)
  const store = useActiveConversationStore.getState()
  store.retainVisiblePane("pane-a", "same", "old")
  store.retainVisiblePane("pane-b", "same", "new")
  store.retainVisiblePane("duplicate", "same", "old")
  expect(isViewingConversation("same", "old")).toBe(true)
  expect(isViewingConversation("same", "new")).toBe(true)
  expect(isViewingConversation("same", "absent")).toBe(false)
  store.releaseVisiblePane("pane-a")
  expect(isViewingConversation("same", "old")).toBe(true)
  store.releaseVisiblePane("duplicate")
  expect(isViewingConversation("same", "old")).toBe(false)
  expect(isViewingConversation("same", "new")).toBe(true)
  jest.restoreAllMocks()
})

it("does not count a hidden browser document as viewed", () => {
  jest.spyOn(document, "hasFocus").mockReturnValue(true)
  jest.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
  useActiveConversationStore.getState().retainVisiblePane("pane", "same", "s")
  expect(isViewingConversation("same", "s")).toBe(false)
  jest.restoreAllMocks()
})

it("shares read capture across duplicate owners until the entire visit closes", () => {
  const store = useActiveConversationStore.getState()
  const firstVisit = store.retainVisiblePane("first", "same", "s")
  firstVisit.markerCaptured = true
  expect(store.retainVisiblePane("second", "same", "s")).toBe(firstVisit)
  store.releaseVisiblePane("first")
  expect(store.retainVisiblePane("third", "same", "s").markerCaptured).toBe(true)
  expect(store.retainVisiblePane("other", "same", "different").markerCaptured).toBe(false)
  store.releaseVisiblePane("second")
  store.releaseVisiblePane("third")
  expect(store.retainVisiblePane("new-visit", "same", "s").markerCaptured).toBe(false)
})
