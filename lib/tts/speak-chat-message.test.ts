jest.mock("@/lib/tts/tts-orchestrator", () => ({
  ttsOrchestrator: {
    speak: jest.fn().mockResolvedValue(undefined),
    speakStream: jest.fn().mockResolvedValue(undefined),
  },
}))

const ensureProviderKeys = jest.fn().mockResolvedValue(undefined)
let storeState: {
  settings: Record<string, unknown> | null
  providerKeys: Record<string, string>
  ensureProviderKeys: jest.Mock
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => storeState },
}))

import { speakChatMessage, speakChatMessageStream } from "./speak-chat-message"
import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"

const mockSpeak = ttsOrchestrator.speak as jest.Mock
const mockSpeakStream = ttsOrchestrator.speakStream as jest.Mock

beforeEach(() => {
  mockSpeak.mockClear()
  mockSpeakStream.mockClear()
  ensureProviderKeys.mockClear()
  storeState = {
    settings: { ttsEnabled: true, ttsProvider: "system" },
    providerKeys: { openai: "sk-test" },
    ensureProviderKeys,
  }
})

describe("speakChatMessage", () => {
  it("returns without speaking when text is blank", async () => {
    await speakChatMessage({ messageId: "m1", text: "   " })
    expect(mockSpeak).not.toHaveBeenCalled()
  })

  it("loads provider keys before reading them, then speaks tagged with sourceId/source", async () => {
    await speakChatMessage({ messageId: "m1", text: "hello" })
    expect(ensureProviderKeys).toHaveBeenCalledTimes(1)
    expect(mockSpeak).toHaveBeenCalledTimes(1)
    const [text, opts] = mockSpeak.mock.calls[0]
    expect(text).toBe("hello")
    expect(opts.source).toBe("chat")
    expect(opts.sourceId).toBe("m1")
    // openai key from the store is projected into providerSettings.
    expect(opts.providerSettings.openai).toEqual({ apiKey: "sk-test" })
  })

  it("applies a character voiceProfile as a SpeechSettings overlay", async () => {
    await speakChatMessage({
      messageId: "m2",
      text: "hi there",
      character: { voiceProfile: { provider: "openai", voiceId: "nova" } },
    })
    const opts = mockSpeak.mock.calls[0][1]
    // Overlay switches the active provider + voice for this utterance.
    expect(opts.speechSettings.ttsProvider).toBe("openai")
    expect(opts.speechSettings.openaiVoice).toBe("nova")
  })

  it("ignores an unknown-provider voiceProfile (falls through to global voice)", async () => {
    await speakChatMessage({
      messageId: "m3",
      text: "hi",
      character: { voiceProfile: { provider: "bogus", voiceId: "x" } as never },
    })
    const opts = mockSpeak.mock.calls[0][1]
    expect(opts.speechSettings.ttsProvider).toBe("system")
  })
})

describe("speakChatMessageStream", () => {
  async function* stream(chunks: string[]): AsyncGenerator<string> {
    for (const c of chunks) yield c
  }

  it("loads keys then hands the token stream to the orchestrator, tagged with source", async () => {
    const tokens = stream(["Hello ", "world."])
    await speakChatMessageStream(tokens, { messageId: "m1" })
    expect(ensureProviderKeys).toHaveBeenCalledTimes(1)
    expect(mockSpeakStream).toHaveBeenCalledTimes(1)
    const [passed, opts] = mockSpeakStream.mock.calls[0]
    expect(passed).toBe(tokens)
    expect(opts.source).toBe("chat")
    expect(opts.sourceId).toBe("m1")
    expect(opts.providerSettings.openai).toEqual({ apiKey: "sk-test" })
  })

  it("applies a character voiceProfile overlay to the streamed settings", async () => {
    await speakChatMessageStream(stream(["hi"]), {
      messageId: "m2",
      character: { voiceProfile: { provider: "openai", voiceId: "nova" } },
    })
    const opts = mockSpeakStream.mock.calls[0][1]
    expect(opts.speechSettings.ttsProvider).toBe("openai")
    expect(opts.speechSettings.openaiVoice).toBe("nova")
  })
})
