/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import {
  chatFusionModeOf,
  isChatFusionMode,
  MAX_REMEMBERED_FUSION_MODES,
  useChatFusionMode,
  useChatFusionModeStore,
} from "./fusion-mode-store"

beforeEach(() => {
  localStorage.clear()
  useChatFusionModeStore.setState({ modes: {} })
})

describe("chat fusion mode store", () => {
  it("is auto until a conversation asks for something else, and auto again when reset", () => {
    expect(chatFusionModeOf("s1")).toBe("auto")
    expect(chatFusionModeOf(null)).toBe("auto")
    useChatFusionModeStore.getState().setMode("s1", "panel")
    useChatFusionModeStore.getState().setMode("s2", "direct")
    expect(chatFusionModeOf("s1")).toBe("panel")
    expect(chatFusionModeOf("s2")).toBe("direct")
    useChatFusionModeStore.getState().setMode("s1", "auto")
    expect(chatFusionModeOf("s1")).toBe("auto")
    expect(useChatFusionModeStore.getState().modes).toEqual({ s2: "direct" })
  })

  it("ignores a value that is not a mode and a missing conversation", () => {
    const before = useChatFusionModeStore.getState().modes
    useChatFusionModeStore.getState().setMode("s1", "delegate" as never)
    useChatFusionModeStore.getState().setMode("", "panel")
    expect(useChatFusionModeStore.getState().modes).toBe(before)
    expect(isChatFusionMode("cascade")).toBe(true)
    expect(isChatFusionMode("delegate")).toBe(false)
  })

  it("remembers a bounded number of conversations, dropping the oldest", () => {
    for (let i = 0; i < MAX_REMEMBERED_FUSION_MODES + 3; i++) {
      useChatFusionModeStore.getState().setMode(`s${i}`, "cascade")
    }
    const modes = useChatFusionModeStore.getState().modes
    expect(Object.keys(modes)).toHaveLength(MAX_REMEMBERED_FUSION_MODES)
    expect(modes.s0).toBeUndefined()
    expect(modes[`s${MAX_REMEMBERED_FUSION_MODES + 2}`]).toBe("cascade")
  })

  it("keeps only well-formed choices when it reads them back", async () => {
    localStorage.setItem(
      "cognia-next.chat-fusion-mode",
      JSON.stringify({ state: { modes: { a: "panel", b: "delegate", c: 3 } }, version: 1 })
    )
    await useChatFusionModeStore.persist.rehydrate()
    expect(useChatFusionModeStore.getState().modes).toEqual({ a: "panel" })
  })

  it("re-renders a subscriber when its conversation's choice changes", () => {
    const { result } = renderHook(() => useChatFusionMode("s1"))
    expect(result.current).toBe("auto")
    act(() => useChatFusionModeStore.getState().setMode("s1", "cascade"))
    expect(result.current).toBe("cascade")
  })
})
