import type { Experimental_RealtimeModelV4 } from "@ai-sdk/provider"

import type { LiveVoiceDeployment, LiveVoiceSettings } from "./types"
import {
  buildLiveVoiceSessionConfig,
  explainLiveVoiceUnavailability,
  LiveVoiceMintFailedError,
  LiveVoiceUnavailableError,
  resolveLiveVoiceSession,
  selectLiveVoiceCandidates,
  type ResolveLiveVoiceSessionDeps,
  type SelectLiveVoiceCandidatesDeps,
} from "./session"

function deployment(overrides: Partial<LiveVoiceDeployment> = {}): LiveVoiceDeployment {
  return {
    id: "d-openai",
    provider: "openai",
    region: "global",
    enabled: true,
    ...overrides,
  }
}

function settings(overrides: Partial<LiveVoiceSettings> = {}): LiveVoiceSettings {
  return {
    enabled: true,
    region: "global",
    fallbackEnabled: true,
    maxCandidates: 3,
    connectTimeoutMs: 10_000,
    historyTurnLimit: 12,
    historyCharacterLimit: 16_000,
    deployments: [deployment()],
    ...overrides,
  }
}

/** The adapter the mint returns; the resolver must hand it straight through. */
const ADAPTER = { specificationVersion: "v4" } as unknown as Experimental_RealtimeModelV4

/** Deterministic eligibility: every provider shipped and switched on. */
function selectDeps(overrides: SelectLiveVoiceCandidatesDeps = {}): SelectLiveVoiceCandidatesDeps {
  return {
    isProviderEnabled: () => true,
    isProviderImplemented: () => true,
    isDesktop: () => true,
    ...overrides,
  }
}

describe("selectLiveVoiceCandidates — gating", () => {
  it("returns nothing when the master switch is off", () => {
    expect(selectLiveVoiceCandidates(settings({ enabled: false }), selectDeps())).toEqual([])
  })

  it("returns nothing when settings have never been written", () => {
    expect(selectLiveVoiceCandidates(undefined, selectDeps())).toEqual([])
  })

  it("skips a disabled deployment", () => {
    const s = settings({ deployments: [deployment({ enabled: false })] })

    expect(selectLiveVoiceCandidates(s, selectDeps())).toEqual([])
  })

  it("never crosses the region boundary", () => {
    // A CN user's audio reaching a Global endpoint is a compliance failure, not
    // a degraded experience — so this must filter, never fall back.
    const s = settings({
      region: "cn",
      deployments: [deployment({ region: "global" }), deployment({ id: "d2", region: "global" })],
    })

    expect(selectLiveVoiceCandidates(s, selectDeps())).toEqual([])
  })

  it("skips a provider whose adapter has not shipped", () => {
    const s = settings({ deployments: [deployment({ provider: "doubao" })] })

    expect(
      selectLiveVoiceCandidates(s, selectDeps({ isProviderImplemented: () => false }))
    ).toEqual([])
  })

  it("skips a provider whose kill switch is off", () => {
    expect(
      selectLiveVoiceCandidates(settings(), selectDeps({ isProviderEnabled: () => false }))
    ).toEqual([])
  })

  it("skips relay-only providers off the desktop", () => {
    // Browsers cannot set the vendor auth headers those handshakes require.
    const s = settings({
      region: "cn",
      deployments: [deployment({ provider: "qwen", region: "cn", model: "qwen-audio-realtime" })],
    })

    expect(selectLiveVoiceCandidates(s, selectDeps({ isDesktop: () => false }))).toEqual([])
    expect(selectLiveVoiceCandidates(s, selectDeps({ isDesktop: () => true }))).toHaveLength(1)
  })

  it("skips a provider with no default model and no configured one", () => {
    // Account-scoped ids have no safe default; dialling a guess produces an
    // opaque vendor error instead of a clear setup error.
    const s = settings({
      region: "cn",
      deployments: [deployment({ provider: "qwen", region: "cn" })],
    })

    expect(selectLiveVoiceCandidates(s, selectDeps())).toEqual([])
  })
})

describe("selectLiveVoiceCandidates — production defaults", () => {
  // No injected seams: these run against the real capability table and the
  // real kill switches, so a wrong default in either shows up here rather than
  // only in a shipped build.

  it("finds a provider that ships an adapter and defaults to enabled", () => {
    expect(selectLiveVoiceCandidates(settings()).map((c) => c.deployment.provider)).toEqual([
      "openai",
    ])
  })

  it("tolerates settings written before `deployments` existed", () => {
    const s = { ...settings(), deployments: undefined } as unknown as LiveVoiceSettings

    expect(selectLiveVoiceCandidates(s)).toEqual([])
    expect(explainLiveVoiceUnavailability(s)).toBe("no-deployments")
  })

  it("excludes a provider whose adapter has not shipped", () => {
    const s = settings({
      region: "cn",
      deployments: [
        deployment({ provider: "doubao", region: "cn", model: "doubao-seed-realtimevoice" }),
      ],
    })

    expect(selectLiveVoiceCandidates(s)).toEqual([])
  })
})

describe("selectLiveVoiceCandidates — dial details", () => {
  it("falls back to the provider's default model and voice", () => {
    const [candidate] = selectLiveVoiceCandidates(settings(), selectDeps())

    expect(candidate.modelOrResource).toBe("gpt-realtime-2.1")
    expect(candidate.voice).toBe("marin")
    expect(candidate.capabilities.inputSampleRate).toBe(24_000)
  })

  it("prefers the configured model over the default", () => {
    const s = settings({ deployments: [deployment({ model: "gpt-realtime-custom" })] })

    expect(selectLiveVoiceCandidates(s, selectDeps())[0].modelOrResource).toBe(
      "gpt-realtime-custom"
    )
  })

  it("accepts an account-bound resource id in place of a model", () => {
    const s = settings({
      region: "cn",
      deployments: [deployment({ provider: "qwen", region: "cn", resourceId: "res-42" })],
    })

    expect(selectLiveVoiceCandidates(s, selectDeps())[0].modelOrResource).toBe("res-42")
  })

  it("omits the voice for a provider with no default so the vendor picks", () => {
    const s = settings({ deployments: [deployment({ provider: "google" })] })

    expect(selectLiveVoiceCandidates(s, selectDeps())[0]).not.toHaveProperty("voice")
  })
})

describe("buildLiveVoiceSessionConfig", () => {
  it("enables Gemini resumption and sliding-window compression", () => {
    const [candidate] = selectLiveVoiceCandidates(
      settings({ deployments: [deployment({ provider: "google" })] }),
      selectDeps()
    )

    expect(buildLiveVoiceSessionConfig({ candidate, resumptionHandle: "handle-1" })).toMatchObject({
      turnDetection: { type: "server-vad" },
      providerOptions: {
        sessionResumption: { handle: "handle-1" },
        contextWindowCompression: {
          triggerTokens: 25_600,
          slidingWindow: { targetTokens: 12_800 },
        },
      },
    })
  })

  it("uses semantic VAD only for OpenAI", () => {
    const [openai] = selectLiveVoiceCandidates(settings(), selectDeps())
    const [xai] = selectLiveVoiceCandidates(
      settings({ deployments: [deployment({ provider: "xai" })] }),
      selectDeps()
    )

    expect(buildLiveVoiceSessionConfig({ candidate: openai }).turnDetection).toEqual({
      type: "semantic-vad",
    })
    expect(buildLiveVoiceSessionConfig({ candidate: xai }).turnDetection).toEqual({
      type: "server-vad",
    })
  })
})

describe("selectLiveVoiceCandidates — ordering and limits", () => {
  const three = settings({
    deployments: [
      deployment({ id: "a" }),
      deployment({ id: "b", provider: "google" }),
      deployment({ id: "c", provider: "xai" }),
    ],
  })

  it("keeps declaration order when nothing is preferred", () => {
    expect(selectLiveVoiceCandidates(three, selectDeps()).map((c) => c.deployment.id)).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("puts the preferred deployment first", () => {
    const s = { ...three, preferredDeploymentId: "c" }

    expect(selectLiveVoiceCandidates(s, selectDeps()).map((c) => c.deployment.id)).toEqual([
      "c",
      "a",
      "b",
    ])
  })

  it("ignores a preferred id that is no longer eligible", () => {
    const s = { ...three, preferredDeploymentId: "gone" }

    expect(selectLiveVoiceCandidates(s, selectDeps()).map((c) => c.deployment.id)).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("caps the list at maxCandidates, counting the preferred one", () => {
    const s = { ...three, maxCandidates: 2 }

    expect(selectLiveVoiceCandidates(s, selectDeps())).toHaveLength(2)
  })

  it("tries only the first when fallback is off", () => {
    const s = { ...three, fallbackEnabled: false }

    expect(selectLiveVoiceCandidates(s, selectDeps())).toHaveLength(1)
  })

  it.each([0, -1, Number.NaN])("still tries one candidate when maxCandidates is %s", (max) => {
    const s = { ...three, maxCandidates: max }

    expect(selectLiveVoiceCandidates(s, selectDeps())).toHaveLength(1)
  })
})

describe("explainLiveVoiceUnavailability", () => {
  it.each([
    ["disabled", settings({ enabled: false })],
    ["no-deployments", settings({ deployments: [] })],
    ["none-eligible", settings()],
  ])("reports %s", (reason, s) => {
    expect(explainLiveVoiceUnavailability(s)).toBe(reason)
  })

  it("reports disabled when settings are absent entirely", () => {
    expect(explainLiveVoiceUnavailability(undefined)).toBe("disabled")
  })
})

describe("resolveLiveVoiceSession", () => {
  function resolveDeps(overrides: ResolveLiveVoiceSessionDeps = {}): ResolveLiveVoiceSessionDeps {
    return { ...selectDeps(), ...overrides }
  }

  it("returns a prepared session for the first candidate that mints", async () => {
    const mintToken = jest.fn().mockResolvedValue({
      token: "ek",
      url: "wss://api.openai.com/v1/realtime",
      expiresAt: 77,
      adapter: ADAPTER,
    })

    const resolved = await resolveLiveVoiceSession(
      { settings: settings(), instructions: "be brief" },
      resolveDeps({ mintToken })
    )

    expect(resolved.session).toEqual({
      deploymentId: "d-openai",
      provider: "openai",
      region: "global",
      modelOrResource: "gpt-realtime-2.1",
      token: "ek",
      url: "wss://api.openai.com/v1/realtime",
      expiresAt: 77,
      capabilities: expect.objectContaining({ inputSampleRate: 24_000 }),
    })
    // The transport must parse events with the adapter that minted the token.
    expect(resolved.adapter).toBe(ADAPTER)
  })

  it("omits expiresAt when the provider reports none", async () => {
    const mintToken = jest.fn().mockResolvedValue({ token: "ek", url: "wss://x", adapter: ADAPTER })

    const resolved = await resolveLiveVoiceSession(
      { settings: settings() },
      resolveDeps({ mintToken })
    )

    expect(resolved.session).not.toHaveProperty("expiresAt")
  })

  it("passes the instructions, voice and BYOK key for that provider", async () => {
    const mintToken = jest.fn().mockResolvedValue({ token: "ek", url: "wss://x", adapter: ADAPTER })

    await resolveLiveVoiceSession(
      {
        settings: settings(),
        instructions: "persona",
        apiKeys: { openai: "sk-user", google: "goog-user" },
        expiresAfterSeconds: 60,
      },
      resolveDeps({ mintToken })
    )

    expect(mintToken).toHaveBeenCalledWith(
      {
        provider: "openai",
        modelId: "gpt-realtime-2.1",
        sessionConfig: {
          instructions: "persona",
          voice: "marin",
          outputModalities: ["audio"],
          inputAudioFormat: { type: "audio/pcm", rate: 24_000 },
          outputAudioFormat: { type: "audio/pcm", rate: 24_000 },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          turnDetection: { type: "semantic-vad" },
        },
        apiKey: "sk-user",
        expiresAfterSeconds: 60,
      },
      undefined
    )
  })

  it("falls back to the next candidate when the first refuses", async () => {
    const mintToken = jest
      .fn()
      .mockRejectedValueOnce(new Error("openai 401"))
      .mockResolvedValueOnce({
        token: "ek",
        url: "wss://generativelanguage.googleapis.com",
        adapter: ADAPTER,
      })
    const onCandidateFailed = jest.fn()
    const s = settings({
      deployments: [deployment({ id: "a" }), deployment({ id: "b", provider: "google" })],
    })

    const resolved = await resolveLiveVoiceSession(
      { settings: s },
      resolveDeps({ mintToken, onCandidateFailed })
    )

    expect(resolved.session.provider).toBe("google")
    expect(onCandidateFailed).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({ message: "openai 401" })
    )
  })

  it("reports every failure when no candidate mints", async () => {
    const mintToken = jest.fn().mockRejectedValue(new Error("network down"))
    const s = settings({
      deployments: [deployment({ id: "a" }), deployment({ id: "b", provider: "xai" })],
    })

    const error = await resolveLiveVoiceSession({ settings: s }, resolveDeps({ mintToken })).catch(
      (e: unknown) => e
    )

    expect(error).toBeInstanceOf(LiveVoiceMintFailedError)
    expect((error as LiveVoiceMintFailedError).failures.map((f) => f.provider)).toEqual([
      "openai",
      "xai",
    ])
    expect((error as Error).message).toContain("network down")
  })

  it("stops immediately when the PII gate rejects the persona", async () => {
    // Every candidate would refuse the same text; retrying only replaces a
    // clear message with a vaguer aggregate one.
    const mintToken = jest
      .fn()
      .mockRejectedValue(
        new Error("live voice instructions were rejected by the PII redaction gate")
      )
    const s = settings({
      deployments: [deployment({ id: "a" }), deployment({ id: "b", provider: "google" })],
    })

    await expect(
      resolveLiveVoiceSession({ settings: s, instructions: "leak" }, resolveDeps({ mintToken }))
    ).rejects.toThrow(/PII redaction gate/)
    expect(mintToken).toHaveBeenCalledTimes(1)
  })

  it("normalises a non-Error rejection", async () => {
    const mintToken = jest.fn().mockRejectedValue("plain string boom")

    const error = await resolveLiveVoiceSession(
      { settings: settings() },
      resolveDeps({ mintToken })
    ).catch((e: unknown) => e)

    expect((error as Error).message).toContain("plain string boom")
  })

  it.each([
    ["disabled", settings({ enabled: false })],
    ["no-deployments", settings({ deployments: [] })],
  ])("throws an unavailable error (%s) without minting", async (reason, s) => {
    const mintToken = jest.fn()

    const error = await resolveLiveVoiceSession({ settings: s }, resolveDeps({ mintToken })).catch(
      (e: unknown) => e
    )

    expect(error).toBeInstanceOf(LiveVoiceUnavailableError)
    expect((error as LiveVoiceUnavailableError).reason).toBe(reason)
    expect(mintToken).not.toHaveBeenCalled()
  })
})
