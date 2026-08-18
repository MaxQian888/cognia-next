/** Metering Proxy around the `@cognia/tts` orchestrator singleton. */
const speakMock = jest.fn<Promise<void>, [string, unknown]>()
const speakStreamMock = jest.fn<Promise<void>, [AsyncIterable<string>, unknown]>()
const stopMock = jest.fn()
const state = { currentProvider: "elevenlabs" as string }
const recordSurfaceUsageMock = jest.fn<Promise<null>, [Record<string, unknown>]>()

jest.mock("./host-bindings", () => ({}))

jest.mock("@cognia/tts/tts-orchestrator", () => ({
  __esModule: true,
  ttsOrchestrator: {
    speak: (text: string, options: unknown) => speakMock(text, options),
    speakStream: (tokens: AsyncIterable<string>, options: unknown) =>
      speakStreamMock(tokens, options),
    stop: () => stopMock(),
    getState: () => state,
  },
}))

jest.mock("@/lib/db/session-usage", () => ({
  recordSurfaceUsage: (args: Record<string, unknown>) => recordSurfaceUsageMock(args),
  swallowUsageWrite: (p: Promise<unknown>) => void p.catch(() => {}),
}))

import { ttsOrchestrator } from "./tts-orchestrator"

async function* tokens(...values: string[]): AsyncIterable<string> {
  for (const value of values) yield value
}

function lastUsage(): Record<string, unknown> {
  const call = recordSurfaceUsageMock.mock.calls.at(-1)
  return (call?.[0] as { usage: Record<string, unknown> }).usage
}

beforeEach(() => {
  speakMock.mockReset().mockResolvedValue(undefined)
  speakStreamMock.mockReset().mockImplementation(async (stream) => {
    // The real orchestrator consumes the stream; the counting tap only sees
    // what is actually pulled.
    for await (const _ of stream) void _
  })
  stopMock.mockReset()
  recordSurfaceUsageMock.mockReset().mockResolvedValue(null)
  state.currentProvider = "elevenlabs"
})

describe("speak", () => {
  it("meters the utterance's characters against the cloud provider", async () => {
    await ttsOrchestrator.speak("hello world")
    expect(speakMock).toHaveBeenCalledWith("hello world", undefined)
    expect(lastUsage()).toMatchObject({
      providerId: "elevenlabs",
      unitBreakdown: { characters: 11 },
      costKnown: false,
    })
  })

  it("does not bill on-device synthesis", async () => {
    state.currentProvider = "system"
    await ttsOrchestrator.speak("hello world")
    // Reporting spend that never happened is worse than reporting none.
    expect(recordSurfaceUsageMock).not.toHaveBeenCalled()
  })

  it("bills the provider that actually ran, not the one requested", async () => {
    // The mobile shell forces `system` regardless of the request.
    state.currentProvider = "system"
    await ttsOrchestrator.speak("hi", { provider: "elevenlabs" })
    expect(recordSurfaceUsageMock).not.toHaveBeenCalled()
  })

  it("skips an empty utterance", async () => {
    await ttsOrchestrator.speak("")
    expect(recordSurfaceUsageMock).not.toHaveBeenCalled()
  })

  it("gives each utterance its own id — the same sentence twice is billed twice", async () => {
    await ttsOrchestrator.speak("again")
    await ttsOrchestrator.speak("again")
    const ids = recordSurfaceUsageMock.mock.calls.map(
      (call) => (call[0] as { operationId: string }).operationId
    )
    expect(ids[0]).not.toBe(ids[1])
  })

  it("does not meter when synthesis failed", async () => {
    speakMock.mockRejectedValue(new Error("quota exceeded"))
    await expect(ttsOrchestrator.speak("hi")).rejects.toThrow("quota exceeded")
    expect(recordSurfaceUsageMock).not.toHaveBeenCalled()
  })
})

describe("speakStream", () => {
  it("bills only the characters the stream actually yielded", async () => {
    await ttsOrchestrator.speakStream(tokens("abc", "de"))
    expect(lastUsage()).toMatchObject({ unitBreakdown: { characters: 5 } })
  })

  it("bills nothing when the consumer pulled nothing", async () => {
    speakStreamMock.mockImplementation(async () => {})
    await ttsOrchestrator.speakStream(tokens("abc", "de"))
    // An aborted stream must not be billed for text it never synthesized.
    expect(recordSurfaceUsageMock).not.toHaveBeenCalled()
  })
})

describe("proxy transparency", () => {
  it("forwards untouched methods to the core singleton", () => {
    ttsOrchestrator.stop()
    expect(stopMock).toHaveBeenCalledTimes(1)
    expect(ttsOrchestrator.getState().currentProvider).toBe("elevenlabs")
  })
})
