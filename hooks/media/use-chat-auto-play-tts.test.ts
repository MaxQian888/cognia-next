import { renderHook } from "@testing-library/react"
import type { UIMessage } from "ai"

const flags = { ttsEnabled: true, ttsAutoPlay: true }
let settingsHolder: typeof flags | null = flags
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: { settings: typeof flags | null }) => unknown) =>
    selector({ settings: settingsHolder }),
}))

const speakChatMessage = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tts/speak-chat-message", () => ({
  speakChatMessage: (...a: unknown[]) => speakChatMessage(...a),
}))

jest.mock("@cognia/logging", () => ({ loggers: { tts: { warn: jest.fn() } } }))

import { useChatAutoPlayTTS } from "./use-chat-auto-play-tts"

type Status = "idle" | "streaming" | "awaiting_approval" | "error"

function asstMsg(id: string, text: string, senderId?: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    ...(senderId ? { metadata: { senderId } } : {}),
  } as UIMessage
}

function setup(initial: {
  messages: UIMessage[]
  status: Status
  characterById?: Map<string, never>
  directCharacter?: unknown
}) {
  return renderHook((props: typeof initial) => useChatAutoPlayTTS(props as never), {
    initialProps: initial,
  })
}

beforeEach(() => {
  speakChatMessage.mockClear()
  settingsHolder = flags
  flags.ttsEnabled = true
  flags.ttsAutoPlay = true
})

describe("useChatAutoPlayTTS", () => {
  it("speaks the last assistant message on streaming → idle", () => {
    const messages = [asstMsg("a1", "final answer")]
    const { rerender } = setup({ messages, status: "streaming" })
    expect(speakChatMessage).not.toHaveBeenCalled()
    rerender({ messages, status: "idle" })
    expect(speakChatMessage).toHaveBeenCalledTimes(1)
    expect(speakChatMessage).toHaveBeenCalledWith({
      messageId: "a1",
      text: "final answer",
      character: null,
    })
  })

  it("does not fire when auto-play is off", () => {
    flags.ttsAutoPlay = false
    const messages = [asstMsg("a1", "hi")]
    const { rerender } = setup({ messages, status: "streaming" })
    rerender({ messages, status: "idle" })
    expect(speakChatMessage).not.toHaveBeenCalled()
  })

  it("does not fire when TTS is disabled", () => {
    flags.ttsEnabled = false
    const messages = [asstMsg("a1", "hi")]
    const { rerender } = setup({ messages, status: "streaming" })
    rerender({ messages, status: "idle" })
    expect(speakChatMessage).not.toHaveBeenCalled()
  })

  it("treats absent settings as disabled (no crash)", () => {
    settingsHolder = null
    const messages = [asstMsg("a1", "hi")]
    const { rerender } = setup({ messages, status: "streaming" })
    rerender({ messages, status: "idle" })
    expect(speakChatMessage).not.toHaveBeenCalled()
  })

  it("does not fire on idle → idle (no completion edge)", () => {
    const messages = [asstMsg("a1", "hi")]
    const { rerender } = setup({ messages, status: "idle" })
    rerender({ messages, status: "idle" })
    expect(speakChatMessage).not.toHaveBeenCalled()
  })

  it("auto-plays each finished message at most once", () => {
    const messages = [asstMsg("a1", "one")]
    const { rerender } = setup({ messages, status: "streaming" })
    rerender({ messages, status: "idle" })
    rerender({ messages, status: "idle" }) // unrelated re-render
    expect(speakChatMessage).toHaveBeenCalledTimes(1)
  })

  it("resolves the team character via senderId", () => {
    const alice = { id: "c1", name: "Alice" } as never
    const characterById = new Map([["c1", alice]])
    const messages = [asstMsg("a1", "hi", "c1")]
    const { rerender } = setup({ messages, status: "streaming", characterById })
    rerender({ messages, status: "idle", characterById })
    expect(speakChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "a1", character: alice })
    )
  })

  it("falls back to the direct session character when there is no senderId", () => {
    const bound = { id: "cb", name: "Bound" }
    const messages = [asstMsg("a1", "hi")]
    const { rerender } = setup({ messages, status: "streaming", directCharacter: bound })
    rerender({ messages, status: "idle", directCharacter: bound })
    expect(speakChatMessage).toHaveBeenCalledWith(expect.objectContaining({ character: bound }))
  })

  it("does nothing when there is no assistant message in the list", () => {
    const onlyUser = { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] } as UIMessage
    const { rerender } = setup({ messages: [onlyUser], status: "streaming" })
    rerender({ messages: [onlyUser], status: "idle" })
    expect(speakChatMessage).not.toHaveBeenCalled()
  })

  it("does not speak when the last assistant message has no text", () => {
    const empty = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-Bash" }],
    } as unknown as UIMessage
    const { rerender } = setup({ messages: [empty], status: "streaming" })
    rerender({ messages: [empty], status: "idle" })
    expect(speakChatMessage).not.toHaveBeenCalled()
  })

  it("extracts only text parts from a mixed-part message", () => {
    const mixed = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "answer" },
      ],
    } as UIMessage
    const { rerender } = setup({ messages: [mixed], status: "streaming" })
    rerender({ messages: [mixed], status: "idle" })
    expect(speakChatMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "answer" }))
  })

  it("swallows a speakChatMessage rejection without throwing", async () => {
    speakChatMessage.mockRejectedValueOnce(new Error("synthesis boom"))
    const messages = [asstMsg("a1", "hi")]
    const { rerender } = setup({ messages, status: "streaming" })
    expect(() => rerender({ messages, status: "idle" })).not.toThrow()
    // Let the rejected promise settle so the catch handler runs.
    await Promise.resolve()
    expect(speakChatMessage).toHaveBeenCalled()
  })

  it("handles a non-Error rejection value", async () => {
    speakChatMessage.mockRejectedValueOnce("string failure")
    const messages = [asstMsg("a1", "hi")]
    const { rerender } = setup({ messages, status: "streaming" })
    rerender({ messages, status: "idle" })
    await Promise.resolve()
    expect(speakChatMessage).toHaveBeenCalled()
  })
})
