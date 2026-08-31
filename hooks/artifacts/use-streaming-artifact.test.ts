/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import type { UIMessage } from "ai"
import { useStreamingArtifact } from "./use-streaming-artifact"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"

function assistant(text: string): UIMessage {
  return { id: "m1", role: "assistant", parts: [{ type: "text", text }] } as UIMessage
}

/** A fenced block that is open and already past the auto-create threshold. */
const OPEN_BLOCK =
  "Sure:\n\n```python\n" + Array.from({ length: 12 }, (_, index) => `print(${index})`).join("\n")

function setArtifactSettings(artifacts: Record<string, unknown>) {
  useSettingsStore.setState({ settings: { artifacts } } as never)
}

beforeEach(() => {
  localStorage.clear()
  useChatStore.setState({
    activeSessionId: "s1",
    status: "streaming",
    messages: [assistant(OPEN_BLOCK)],
  })
  setArtifactSettings({})
})

describe("useStreamingArtifact", () => {
  it("reports the block the assistant is still writing", () => {
    const { result } = renderHook(() => useStreamingArtifact("s1"))
    expect(result.current?.type).toBe("code")
    expect(result.current?.lineCount).toBe(12)
  })

  it("reports nothing once the turn is no longer streaming", () => {
    useChatStore.setState({ status: "idle" })
    const { result } = renderHook(() => useStreamingArtifact("s1"))
    expect(result.current).toBeNull()
  })

  it("never claims a session with no slice is generating something", () => {
    const { result } = renderHook(() => useStreamingArtifact("some-other-session"))
    expect(result.current).toBeNull()
  })

  it("detects the block a BACKGROUND pane is writing", () => {
    // This used to bail out for any unfocused session, so a background pane
    // streaming a long code block showed no placeholder and then produced an
    // artifact on turn-complete out of nowhere.
    useChatStore.setState({
      sessions: {
        s2: { status: "streaming", messages: [assistant(OPEN_BLOCK)] },
      },
    } as never)
    const { result } = renderHook(() => useStreamingArtifact("s2"))
    expect(result.current?.type).toBe("code")
    expect(result.current?.lineCount).toBe(12)
  })

  it("does not borrow the focused pane's turn for an idle background one", () => {
    useChatStore.setState({
      sessions: { s2: { status: "idle", messages: [assistant(OPEN_BLOCK)] } },
    } as never)
    const { result } = renderHook(() => useStreamingArtifact("s2"))
    expect(result.current).toBeNull()
  })

  it("stays quiet when auto-creation is switched off", () => {
    // The turn-complete handler would decline to create it, so promising one
    // here would be a lie.
    setArtifactSettings({ autoCreate: false })
    const { result } = renderHook(() => useStreamingArtifact("s1"))
    expect(result.current).toBeNull()
  })

  it("stays quiet when artifact authoring is switched off", () => {
    setArtifactSettings({ agentAuthoring: false })
    const { result } = renderHook(() => useStreamingArtifact("s1"))
    expect(result.current).toBeNull()
  })

  it("honours the user's minLines threshold", () => {
    setArtifactSettings({ minLines: 50 })
    const { result } = renderHook(() => useStreamingArtifact("s1"))
    expect(result.current).toBeNull()
  })

  it("reports nothing when the assistant has not opened a fence", () => {
    useChatStore.setState({ messages: [assistant("just some prose, no code yet")] })
    const { result } = renderHook(() => useStreamingArtifact("s1"))
    expect(result.current).toBeNull()
  })

  it("ignores non-text parts such as tool calls and reasoning", () => {
    useChatStore.setState({
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [
            { type: "reasoning", text: "thinking about it" },
            { type: "tool-call", toolName: "read" },
            { type: "text", text: OPEN_BLOCK },
          ],
        },
      ] as never,
    })
    const { result } = renderHook(() => useStreamingArtifact("s1"))
    expect(result.current?.lineCount).toBe(12)
  })

  it("reports nothing when the turn has produced no assistant message yet", () => {
    useChatStore.setState({
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "write me code" }] },
      ] as never,
    })
    const { result } = renderHook(() => useStreamingArtifact("s1"))
    expect(result.current).toBeNull()
  })

  it("honours an explicit enabled-types whitelist", () => {
    setArtifactSettings({ enabledTypes: ["svg"] })
    const { result } = renderHook(() => useStreamingArtifact("s1"))
    expect(result.current).toBeNull()
  })

  it("works without a session scope when the caller has none", () => {
    const { result } = renderHook(() => useStreamingArtifact())
    expect(result.current?.type).toBe("code")
  })

  it("reports nothing once the block closes — the store owns it from then on", () => {
    useChatStore.setState({ messages: [assistant(OPEN_BLOCK + "\n```\ndone")] })
    const { result } = renderHook(() => useStreamingArtifact("s1"))
    expect(result.current).toBeNull()
  })
})
