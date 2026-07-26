/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import {
  useActiveArtifactId,
  useArtifactSessionId,
  useOpenArtifactIds,
} from "./use-session-artifacts"
import { NO_SESSION_KEY, useArtifactStore } from "@/stores/artifact/artifact-store"
import { useChatStore } from "@/stores/chat"

beforeEach(() => {
  localStorage.clear()
  act(() => {
    useChatStore.setState({ activeSessionId: null })
    useArtifactStore.setState({
      artifacts: {},
      activeArtifactIdBySession: {},
      openArtifactIdsBySession: {},
    })
  })
})

function seed(sessionId: string, title: string) {
  return useArtifactStore
    .getState()
    .createArtifact({ sessionId, messageId: "m", type: "code", title, content: "x" })
}

describe("useActiveArtifactId / useOpenArtifactIds", () => {
  it("shows only the on-screen conversation's tabs", () => {
    const a = seed("s1", "A")
    const b = seed("s1", "B")
    const other = seed("s2", "Other")
    act(() => useChatStore.setState({ activeSessionId: "s1" }))

    const { result } = renderHook(() => ({
      active: useActiveArtifactId(),
      open: useOpenArtifactIds(),
    }))

    expect(result.current.active).toBe(b.id)
    expect(result.current.open).toEqual([a.id, b.id])
    expect(result.current.open).not.toContain(other.id)
  })

  it("follows the conversation when the user switches sessions", () => {
    seed("s1", "A")
    const other = seed("s2", "Other")
    act(() => useChatStore.setState({ activeSessionId: "s1" }))

    const { result } = renderHook(() => ({
      active: useActiveArtifactId(),
      open: useOpenArtifactIds(),
    }))

    // The dock used to keep showing the previous conversation's tab strip and
    // preview beside the new conversation's artifact list and browser.
    act(() => useChatStore.setState({ activeSessionId: "s2" }))

    expect(result.current.active).toBe(other.id)
    expect(result.current.open).toEqual([other.id])
  })

  it("falls back to the session-less bucket when no conversation is mounted", () => {
    const loose = seed("", "Loose")

    const { result } = renderHook(() => ({
      session: useArtifactSessionId(),
      active: useActiveArtifactId(),
      open: useOpenArtifactIds(),
    }))

    // Matches the `?? "none"` scope key the workbench already builds, so a
    // Sheet opened with no chat behind it still resolves its own artifacts.
    expect(result.current.session).toBeNull()
    expect(useArtifactStore.getState().openArtifactIdsBySession[NO_SESSION_KEY]).toEqual([loose.id])
    expect(result.current.active).toBe(loose.id)
    expect(result.current.open).toEqual([loose.id])
  })

  it("returns a stable empty array for a conversation with no artifacts", () => {
    act(() => useChatStore.setState({ activeSessionId: "empty" }))
    const { result, rerender } = renderHook(() => useOpenArtifactIds())
    const first = result.current

    rerender()

    // A fresh `[]` per render would re-fire every effect that depends on it.
    expect(first).toEqual([])
    expect(result.current).toBe(first)
  })
})
