/** @jest-environment jsdom */

import { useActiveConversationStore, isViewingConversation } from "./active-conversation-store"

beforeEach(() => {
  useActiveConversationStore.setState({ activeConversationKey: null })
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
