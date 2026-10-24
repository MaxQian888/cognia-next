import { renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { ChatScopeProvider } from "@/components/chat/chat-scope-provider"
import { TranscriptSessionProvider } from "@/components/chat/transcript-session-context"
import {
  __resetA2UIChatBindingsForTesting,
  getA2UIChatBinding,
} from "@/lib/a2ui/chat-action-routing"
import { useA2UIChatBinding } from "./use-a2ui-chat-binding"

function within(transcript: string | null, scope: string | null) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const scoped = scope ? (
      <ChatScopeProvider sessionId={scope}>{children}</ChatScopeProvider>
    ) : (
      children
    )
    return <TranscriptSessionProvider sessionId={transcript}>{scoped}</TranscriptSessionProvider>
  }
}

beforeEach(() => __resetA2UIChatBindingsForTesting())

describe("useA2UIChatBinding", () => {
  it("prefers the transcript's session, then the row's, then the chat scope's", () => {
    const { result: transcript } = renderHook(
      () => useA2UIChatBinding("s", { sessionId: "row", enabled: false }),
      { wrapper: within("pane", "scope") }
    )
    expect(transcript.current).toBe("pane")

    const { result: row } = renderHook(
      () => useA2UIChatBinding("s", { sessionId: "row", enabled: false }),
      { wrapper: within(null, "scope") }
    )
    expect(row.current).toBe("row")

    const { result: scope } = renderHook(() => useA2UIChatBinding("s", { enabled: false }), {
      wrapper: within(null, "scope"),
    })
    expect(scope.current).toBe("scope")
  })

  it("binds while enabled and mounted, and releases on unmount", () => {
    const { unmount, rerender } = renderHook(
      ({ enabled }) => useA2UIChatBinding("trip", { messageId: "m1", enabled }),
      { wrapper: within("pane", null), initialProps: { enabled: false } }
    )
    expect(getA2UIChatBinding("trip")).toBeUndefined()
    rerender({ enabled: true })
    expect(getA2UIChatBinding("trip")).toEqual({ sessionId: "pane", messageId: "m1" })
    unmount()
    expect(getA2UIChatBinding("trip")).toBeUndefined()
  })

  it("never binds outside a conversation or without a surface", () => {
    renderHook(() => useA2UIChatBinding("trip", { enabled: true }), { wrapper: within(null, null) })
    renderHook(() => useA2UIChatBinding(null, { enabled: true }), { wrapper: within("pane", null) })
    expect(getA2UIChatBinding("trip")).toBeUndefined()
  })
})
