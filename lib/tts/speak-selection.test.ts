type Subscriber = (state: Record<string, unknown>) => void

const subscribers = new Set<Subscriber>()
let orchestratorState: Record<string, unknown> = {}

jest.mock("@/lib/tts/tts-orchestrator", () => ({
  ttsOrchestrator: {
    speak: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    getState: () => orchestratorState,
    subscribe: (subscriber: Subscriber) => {
      subscribers.add(subscriber)
      subscriber(orchestratorState)
      return () => subscribers.delete(subscriber)
    },
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

import { speakSelection, stopSelectionSpeech, watchSelectionSpeech } from "./speak-selection"
import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"

const mockSpeak = ttsOrchestrator.speak as jest.Mock
const mockStop = ttsOrchestrator.stop as jest.Mock

function emit(state: Record<string, unknown>) {
  orchestratorState = state
  subscribers.forEach((subscriber) => subscriber(state))
}

beforeEach(() => {
  jest.clearAllMocks()
  subscribers.clear()
  orchestratorState = {}
  storeState = {
    settings: { ttsEnabled: true, ttsProvider: "system" },
    providerKeys: { openai: "sk-test" },
    ensureProviderKeys,
  }
})

describe("speakSelection", () => {
  it("returns without speaking when the selection is blank", async () => {
    await speakSelection({ candidateId: "c1", text: "   " })
    expect(mockSpeak).not.toHaveBeenCalled()
  })

  it("loads provider keys then speaks tagged with the candidate", async () => {
    await speakSelection({ candidateId: "c1", text: "read me" })
    expect(ensureProviderKeys).toHaveBeenCalledTimes(1)
    const [text, opts] = mockSpeak.mock.calls[0]
    expect(text).toBe("read me")
    // `sourceId` is what lets the toolbar tell its own playback apart from a
    // chat message being read at the same time.
    expect(opts.source).toBe("selection")
    expect(opts.sourceId).toBe("c1")
    expect(opts.providerSettings.openai).toEqual({ apiKey: "sk-test" })
  })
})

describe("stopSelectionSpeech", () => {
  it("stops playback that belongs to this candidate", () => {
    orchestratorState = { activeSource: "selection", activeSourceId: "c1" }
    stopSelectionSpeech("c1")
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it("leaves another candidate's playback alone", () => {
    orchestratorState = { activeSource: "selection", activeSourceId: "c2" }
    stopSelectionSpeech("c1")
    expect(mockStop).not.toHaveBeenCalled()
  })

  it("never stops a chat message that happens to be speaking", () => {
    orchestratorState = { activeSource: "chat", activeSourceId: "c1" }
    stopSelectionSpeech("c1")
    expect(mockStop).not.toHaveBeenCalled()
  })
})

describe("watchSelectionSpeech", () => {
  it("reports progress while ours is playing", () => {
    const seen: Array<{ playing: boolean; progress?: number }> = []
    watchSelectionSpeech("c1", (update) => seen.push(update))
    emit({ activeSource: "selection", activeSourceId: "c1", isPlaying: true, progress: 0.5 })
    expect(seen).toContainEqual({ playing: true, progress: 0.5 })
  })

  it("treats loading as playing so the transport appears immediately", () => {
    const seen: Array<{ playing: boolean; progress?: number }> = []
    watchSelectionSpeech("c1", (update) => seen.push(update))
    emit({ activeSource: "selection", activeSourceId: "c1", isLoading: true, progress: 0 })
    expect(seen).toContainEqual({ playing: true, progress: 0 })
  })

  it("emits a single completion once the orchestrator releases the source", () => {
    const seen: Array<{ playing: boolean }> = []
    watchSelectionSpeech("c1", (update) => seen.push(update))
    emit({ activeSource: "selection", activeSourceId: "c1", isPlaying: true, progress: 0.2 })
    emit({})
    emit({})
    expect(seen.filter((update) => !update.playing)).toHaveLength(1)
  })

  it("stays quiet when playback never started, so the toolbar is not released early", () => {
    const seen: Array<{ playing: boolean }> = []
    watchSelectionSpeech("c1", (update) => seen.push(update))
    // Some other surface is speaking; ours has not begun.
    emit({ activeSource: "chat", activeSourceId: "m9", isPlaying: true })
    expect(seen).toHaveLength(0)
  })

  it("unsubscribes on dispose", () => {
    const seen: Array<{ playing: boolean }> = []
    const dispose = watchSelectionSpeech("c1", (update) => seen.push(update))
    dispose()
    emit({ activeSource: "selection", activeSourceId: "c1", isPlaying: true })
    expect(seen).toHaveLength(0)
  })
})
