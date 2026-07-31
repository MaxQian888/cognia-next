jest.mock("@/lib/tts/tts-orchestrator", () => ({
  ttsOrchestrator: { speak: jest.fn().mockResolvedValue(undefined) },
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

import { speakPetText } from "./speak-pet"
import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"

const mockSpeak = ttsOrchestrator.speak as jest.Mock

beforeEach(() => {
  mockSpeak.mockClear()
  ensureProviderKeys.mockClear()
  storeState = {
    settings: { ttsEnabled: true, ttsProvider: "system" },
    providerKeys: { openai: "sk-test" },
    ensureProviderKeys,
  }
})

describe("speakPetText", () => {
  it("returns without speaking when text is blank", async () => {
    await speakPetText("   ")
    expect(mockSpeak).not.toHaveBeenCalled()
  })

  it("loads keys then speaks tagged with the pet source", async () => {
    await speakPetText("hello from the pet")
    expect(ensureProviderKeys).toHaveBeenCalledTimes(1)
    expect(mockSpeak).toHaveBeenCalledTimes(1)
    const [text, opts] = mockSpeak.mock.calls[0]
    expect(text).toBe("hello from the pet")
    expect(opts.source).toBe("pet")
    expect(opts.providerSettings.openai).toEqual({ apiKey: "sk-test" })
  })

  it("applies the character voiceProfile as a SpeechSettings overlay", async () => {
    await speakPetText("hi", { voiceProfile: { provider: "openai", voiceId: "nova" } })
    const opts = mockSpeak.mock.calls[0][1]
    expect(opts.speechSettings.ttsProvider).toBe("openai")
    expect(opts.speechSettings.openaiVoice).toBe("nova")
  })

  it("falls through to the global voice for a null character", async () => {
    await speakPetText("hi", null)
    const opts = mockSpeak.mock.calls[0][1]
    expect(opts.speechSettings.ttsProvider).toBe("system")
  })
})
