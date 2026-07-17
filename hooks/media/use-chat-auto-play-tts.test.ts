import { renderHook } from "@testing-library/react"
import type { UIMessage } from "ai"

const flags = { ttsEnabled: true, ttsAutoPlay: true }
let settingsHolder: typeof flags | null = flags
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: { settings: typeof flags | null }) => unknown) =>
    selector({ settings: settingsHolder }),
}))

const speakChatMessage = jest.fn().mockResolvedValue(undefined)
const speakChatMessageStream = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tts/speak-chat-message", () => ({
  speakChatMessage: (...a: unknown[]) => speakChatMessage(...a),
  speakChatMessageStream: (...a: unknown[]) => speakChatMessageStream(...a),
}))

interface FakePushable {
  push: jest.Mock
  close: jest.Mock
  stream: AsyncIterable<string>
}
const pushables: FakePushable[] = []
jest.mock("@/lib/tts/pushable-stream", () => ({
  createPushableStream: () => {
    const p: FakePushable = {
      push: jest.fn(),
      close: jest.fn(),
      stream: {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
        }),
      },
    }
    pushables.push(p)
    return p
  },
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
  speakChatMessageStream.mockClear()
  pushables.length = 0
  settingsHolder = flags
  flags.ttsEnabled = true
  flags.ttsAutoPlay = true
})

describe("useChatAutoPlayTTS — streaming path", () => {
  it("streams the reply while the turn is in flight and feeds the initial text", () => {
    setup({ messages: [asstMsg("a1", "partial answer")], status: "streaming" })
    expect(speakChatMessageStream).toHaveBeenCalledTimes(1)
    expect(speakChatMessageStream).toHaveBeenCalledWith(expect.anything(), {
      messageId: "a1",
      character: null,
    })
    expect(pushables[0].push).toHaveBeenCalledWith("partial answer")
    expect(speakChatMessage).not.toHaveBeenCalled()
  })

  it("feeds only the newly-appended text as deltas", () => {
    const { rerender } = setup({ messages: [asstMsg("a1", "Hello")], status: "streaming" })
    rerender({ messages: [asstMsg("a1", "Hello, world")], status: "streaming" })
    expect(pushables[0].push).toHaveBeenNthCalledWith(1, "Hello")
    expect(pushables[0].push).toHaveBeenNthCalledWith(2, ", world")
  })

  it("does not re-read the message on completion (no double-speak) and flushes the tail", () => {
    const { rerender } = setup({ messages: [asstMsg("a1", "answer")], status: "streaming" })
    rerender({ messages: [asstMsg("a1", "answer")], status: "idle" })
    expect(speakChatMessageStream).toHaveBeenCalledTimes(1)
    expect(speakChatMessage).not.toHaveBeenCalled()
    expect(pushables[0].close).toHaveBeenCalled()
  })

  it("does not start a stream for a tool-only (text-less) message", () => {
    const toolOnly = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-Bash" }],
    } as unknown as UIMessage
    setup({ messages: [toolOnly], status: "streaming" })
    expect(speakChatMessageStream).not.toHaveBeenCalled()
  })

  it("keeps the session across a mid-turn approval pause (no restart)", () => {
    const { rerender } = setup({ messages: [asstMsg("a1", "Start")], status: "streaming" })
    rerender({ messages: [asstMsg("a1", "Start")], status: "awaiting_approval" })
    rerender({ messages: [asstMsg("a1", "Start and more")], status: "streaming" })
    expect(speakChatMessageStream).toHaveBeenCalledTimes(1) // one session, not restarted
    expect(pushables).toHaveLength(1)
    expect(pushables[0].push).toHaveBeenNthCalledWith(2, " and more")
  })

  it("resolves the team character via senderId", () => {
    const alice = { id: "c1", name: "Alice" } as never
    const characterById = new Map([["c1", alice]])
    setup({ messages: [asstMsg("a1", "hi", "c1")], status: "streaming", characterById })
    expect(speakChatMessageStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ character: alice })
    )
  })

  it("swallows a streaming rejection without throwing", async () => {
    speakChatMessageStream.mockRejectedValueOnce(new Error("boom"))
    expect(() => setup({ messages: [asstMsg("a1", "hi")], status: "streaming" })).not.toThrow()
    await Promise.resolve()
    expect(speakChatMessageStream).toHaveBeenCalled()
  })
})

describe("useChatAutoPlayTTS — turn-complete fallback", () => {
  it("reads the finished message when streaming never ran (message appears at idle)", () => {
    const user = { id: "u1", role: "user", parts: [{ type: "text", text: "q" }] } as UIMessage
    const { rerender } = setup({ messages: [user], status: "streaming" })
    expect(speakChatMessageStream).not.toHaveBeenCalled()
    rerender({ messages: [user, asstMsg("a1", "final")], status: "idle" })
    expect(speakChatMessage).toHaveBeenCalledWith({
      messageId: "a1",
      text: "final",
      character: null,
    })
  })

  it("does not fire on idle → idle (no completion edge)", () => {
    const messages = [asstMsg("a1", "hi")]
    const { rerender } = setup({ messages, status: "idle" })
    rerender({ messages, status: "idle" })
    expect(speakChatMessage).not.toHaveBeenCalled()
  })
})

describe("useChatAutoPlayTTS — gating", () => {
  it("neither streams nor speaks when auto-play is off", () => {
    flags.ttsAutoPlay = false
    const { rerender } = setup({ messages: [asstMsg("a1", "hi")], status: "streaming" })
    rerender({ messages: [asstMsg("a1", "hi")], status: "idle" })
    expect(speakChatMessageStream).not.toHaveBeenCalled()
    expect(speakChatMessage).not.toHaveBeenCalled()
  })

  it("neither streams nor speaks when TTS is disabled", () => {
    flags.ttsEnabled = false
    const { rerender } = setup({ messages: [asstMsg("a1", "hi")], status: "streaming" })
    rerender({ messages: [asstMsg("a1", "hi")], status: "idle" })
    expect(speakChatMessageStream).not.toHaveBeenCalled()
    expect(speakChatMessage).not.toHaveBeenCalled()
  })

  it("treats absent settings as disabled (no crash)", () => {
    settingsHolder = null
    const { rerender } = setup({ messages: [asstMsg("a1", "hi")], status: "streaming" })
    rerender({ messages: [asstMsg("a1", "hi")], status: "idle" })
    expect(speakChatMessageStream).not.toHaveBeenCalled()
    expect(speakChatMessage).not.toHaveBeenCalled()
  })
})
