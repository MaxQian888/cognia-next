import {
  IMPLEMENTED_LIVE_VOICE_PROVIDERS,
  LIVE_VOICE_CAPABILITIES,
  LiveVoiceProviderUnavailableError,
  createLiveAdapter,
  getLiveVoiceCapabilities,
  isLiveVoiceProviderImplemented,
  type LiveAdapterLoader,
} from "./adapter-registry"
import { LIVE_VOICE_PROVIDER_IDS, type LiveVoiceProviderId } from "./types"

const CHINA_PROVIDERS: LiveVoiceProviderId[] = ["qwen", "doubao", "baidu"]

describe("LIVE_VOICE_CAPABILITIES", () => {
  it("declares capabilities for every provider — none can be selectable without them", () => {
    expect(Object.keys(LIVE_VOICE_CAPABILITIES).sort()).toEqual([...LIVE_VOICE_PROVIDER_IDS].sort())
  })

  it.each(LIVE_VOICE_PROVIDER_IDS)("gives %s positive sample rates", (provider) => {
    const { inputSampleRate, outputSampleRate } = LIVE_VOICE_CAPABILITIES[provider]

    expect(inputSampleRate).toBeGreaterThan(0)
    expect(outputSampleRate).toBeGreaterThan(0)
  })

  it("routes exactly the China providers through the relay", () => {
    const relayed = LIVE_VOICE_PROVIDER_IDS.filter(
      (id) => LIVE_VOICE_CAPABILITIES[id].requiresRelay
    )

    expect(relayed.sort()).toEqual([...CHINA_PROVIDERS].sort())
  })

  // Working Rule 7: intentional dormancy is pinned by a test, not just a comment.
  it.each(["doubao", "baidu"] as const)("ships %s with tools dormant in v1", (provider) => {
    expect(LIVE_VOICE_CAPABILITIES[provider].supportsTools).toBe(false)
  })

  it.each(["openai", "google", "xai", "qwen"] as const)("enables tools for %s", (provider) => {
    expect(LIVE_VOICE_CAPABILITIES[provider].supportsTools).toBe(true)
  })

  it("expects 16 kHz uplink for Gemini Live, not the OpenAI 24 kHz default", () => {
    expect(LIVE_VOICE_CAPABILITIES.google.inputSampleRate).toBe(16_000)
    expect(LIVE_VOICE_CAPABILITIES.openai.inputSampleRate).toBe(24_000)
  })
})

describe("getLiveVoiceCapabilities", () => {
  it("returns the table entry for a provider", () => {
    expect(getLiveVoiceCapabilities("openai")).toBe(LIVE_VOICE_CAPABILITIES.openai)
  })
})

describe("isLiveVoiceProviderImplemented", () => {
  it.each(IMPLEMENTED_LIVE_VOICE_PROVIDERS)("accepts %s", (provider) => {
    expect(isLiveVoiceProviderImplemented(provider)).toBe(true)
  })

  it.each(CHINA_PROVIDERS)("rejects %s until the Phase 2 relay lands", (provider) => {
    expect(isLiveVoiceProviderImplemented(provider)).toBe(false)
  })
})

describe("createLiveAdapter", () => {
  it("dispatches to the loader for the requested provider", async () => {
    const stub = { specificationVersion: "v4" } as never
    const openai: LiveAdapterLoader = jest.fn().mockResolvedValue(stub)
    const xai: LiveAdapterLoader = jest.fn().mockResolvedValue({} as never)

    const adapter = await createLiveAdapter(
      { provider: "openai", modelId: "gpt-realtime-2.1" },
      { openai, xai }
    )

    expect(adapter).toBe(stub)
    expect(xai).not.toHaveBeenCalled()
  })

  it("forwards the whole request so the loader can apply BYOK credentials", async () => {
    const openai: LiveAdapterLoader = jest.fn().mockResolvedValue({} as never)
    const request = {
      provider: "openai",
      modelId: "gpt-realtime-2.1",
      apiKey: "sk-test",
      baseURL: "https://proxy.example",
    } as const

    await createLiveAdapter(request, { openai })

    expect(openai).toHaveBeenCalledWith(request)
  })

  it.each(CHINA_PROVIDERS)(
    "throws a typed error for %s with the default loaders",
    async (provider) => {
      await expect(createLiveAdapter({ provider, modelId: "whatever" })).rejects.toBeInstanceOf(
        LiveVoiceProviderUnavailableError
      )
    }
  )

  it("names the provider on the thrown error", async () => {
    let error: LiveVoiceProviderUnavailableError | undefined
    try {
      await createLiveAdapter({ provider: "doubao", modelId: "x" })
    } catch (caught) {
      error = caught as LiveVoiceProviderUnavailableError
    }

    expect(error?.provider).toBe("doubao")
    expect(error?.name).toBe("LiveVoiceProviderUnavailableError")
    expect(error?.message).toMatch(/doubao/)
  })

  it("propagates a loader failure rather than swallowing it", async () => {
    const openai: LiveAdapterLoader = jest.fn().mockRejectedValue(new Error("bad key"))

    await expect(
      createLiveAdapter({ provider: "openai", modelId: "gpt-realtime-2.1" }, { openai })
    ).rejects.toThrow("bad key")
  })
})

/**
 * Contract pin against the real AI SDK packages. `experimental_realtime` is an
 * experimental surface on a pinned version, so a minor bump that drops it — or
 * changes the RealtimeModelV4 method set our session shell drives — has to fail
 * here rather than at runtime in a voice call.
 */
describe("real AI SDK adapters", () => {
  const MODELS: Record<string, string> = {
    openai: "gpt-realtime-2.1",
    google: "gemini-3.1-flash-live-preview",
    xai: "grok-voice-latest",
  }

  it.each(IMPLEMENTED_LIVE_VOICE_PROVIDERS)(
    "builds a v4 realtime model for %s",
    async (provider) => {
      const adapter = await createLiveAdapter({
        provider,
        modelId: MODELS[provider],
        apiKey: "test-key",
      })

      expect(adapter.specificationVersion).toBe("v4")
      expect(adapter.modelId).toBe(MODELS[provider])
      for (const method of [
        "doCreateClientSecret",
        "getWebSocketConfig",
        "parseServerEvent",
        "serializeClientEvent",
        "buildSessionConfig",
      ] as const) {
        expect(typeof adapter[method]).toBe("function")
      }
    }
  )

  it("builds a session config the provider accepts", async () => {
    const adapter = await createLiveAdapter({
      provider: "openai",
      modelId: MODELS.openai,
      apiKey: "test-key",
    })

    expect(
      adapter.buildSessionConfig({
        instructions: "be brief",
        voice: "marin",
        turnDetection: { type: "semantic-vad" },
      })
    ).toEqual(expect.any(Object))
  })
})
