/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import { writeSharedChatPreference } from "@/lib/collab/shared-chat-feature"

import { useSharedChatEnabled } from "./use-shared-chat-enabled"

describe("useSharedChatEnabled", () => {
  const buildFlag = process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED

  beforeEach(() => localStorage.clear())

  afterEach(() => {
    if (buildFlag === undefined) delete process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED
    else process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED = buildFlag
  })

  it("reports enabled when the build allows it and nobody opted out", () => {
    const { result } = renderHook(() => useSharedChatEnabled())
    expect(result.current).toBe(true)
  })

  it("picks up a stored opt-out after mount", () => {
    writeSharedChatPreference(false)
    const { result } = renderHook(() => useSharedChatEnabled())
    expect(result.current).toBe(false)
  })

  it("follows the switch without a reload", () => {
    // The point of the subscription: a header that keeps offering to share a
    // conversation after the setting was turned off is a lie the user cannot
    // see through.
    const { result } = renderHook(() => useSharedChatEnabled())
    expect(result.current).toBe(true)

    act(() => writeSharedChatPreference(false))
    expect(result.current).toBe(false)

    act(() => writeSharedChatPreference(true))
    expect(result.current).toBe(true)
  })

  it("stays off when the build says no, whatever was stored", () => {
    writeSharedChatPreference(true)
    process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED = "false"
    const { result } = renderHook(() => useSharedChatEnabled())
    expect(result.current).toBe(false)
  })
})
