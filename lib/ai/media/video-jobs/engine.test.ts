import type { ProviderSettingsSnapshot } from "@/lib/ai/provider-consumption"
import { credentialAffinityOf } from "@/lib/ai/operations/credential-affinity"
import {
  FIRST_POLL_DELAY_MS,
  PROXY_BODY_LIMIT_MESSAGE,
  VIDEO_JOB_DEADLINE_MS,
  createVideoJobEngine,
  type VideoJobEngineDeps,
} from "./engine"
import { createInMemoryMediaJobStore } from "./store"
import type { MediaGenerationJobRow } from "./types"

jest.mock("../provider-generation", () => {
  const actual = jest.requireActual("../provider-generation")
  return { ...actual, createProviderVideoModel: jest.fn(() => ({ fake: "model" })) }
})

const NOW = 1_800_000_000_000

function snapshot(apiKey = "rep-key"): ProviderSettingsSnapshot {
  return {
    defaultProvider: "replicate",
    providers: { replicate: { enabled: true, apiKey } },
    customProviders: [],
  }
}

function setup(overrides: Partial<VideoJobEngineDeps> = {}) {
  let now = NOW
  const store = createInMemoryMediaJobStore()
  let settings = snapshot()
  const startVideo = jest.fn().mockResolvedValue({
    operation: { getUrl: "https://api.replicate.com/v1/predictions/p1" },
    warnings: [{ type: "unsupported", feature: "fps", details: "ignored" }],
    response: {},
  })
  const getVideoStatus = jest.fn()
  const fetch = jest.fn()
  const materialize = jest.fn(async (row: MediaGenerationJobRow, blob: Blob) => ({
    content: { kind: "library" as const, assetId: `asset-${row.id}` },
    mediaType: blob.type,
    byteSize: blob.size,
  }))
  const resolveStartFrame = jest.fn(async () => ({
    data: new Uint8Array([1, 2]),
    mediaType: "image/png",
  }))
  const deps: VideoJobEngineDeps = {
    store,
    now: () => now,
    getSnapshot: () => settings,
    fetch,
    reachesNonCorsHosts: () => true,
    resolveStartFrame,
    materialize,
    maxResultBytes: 1000,
    startVideo,
    getVideoStatus,
    newId: () => "vjob_1",
    ...overrides,
  }
  const engine = createVideoJobEngine(deps)
  return {
    engine,
    store,
    startVideo,
    getVideoStatus,
    fetch,
    materialize,
    resolveStartFrame,
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
    setSettings: (next: ProviderSettingsSnapshot) => {
      settings = next
    },
  }
}

const origin = { surface: "chat-tool", sessionId: "s1" } as const

async function started(t: ReturnType<typeof setup>) {
  const result = await t.engine.start({ prompt: "A paper boat", origin })
  if (!result.ok) throw new Error(result.error.message)
  return result.job
}

describe("startVideoJob", () => {
  it("starts the provider job and persists the operation and provider coordinates", async () => {
    const t = setup()
    const job = await started(t)

    expect(t.startVideo).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "A paper boat", model: { fake: "model" } })
    )
    expect(job).toMatchObject({
      id: "vjob_1",
      sessionId: "s1",
      status: "generating",
      operation: { getUrl: "https://api.replicate.com/v1/predictions/p1" },
      provider: {
        providerId: "replicate",
        modelId: "minimax/video-01",
        credentialAffinity: credentialAffinityOf("rep-key"),
      },
      nextPollAt: NOW + FIRST_POLL_DELAY_MS,
      deadlineAt: NOW + VIDEO_JOB_DEADLINE_MS,
      warnings: ["fps: ignored"],
    })
    await expect(t.store.get("vjob_1")).resolves.toEqual(job)
  })

  it("sends a start frame as the image prompt and records only a reference", async () => {
    const t = setup()
    const result = await t.engine.start({
      prompt: "Animate this",
      startFrame: { kind: "media", ref: "cognia-media:abc" },
      origin,
    })
    expect(result.ok).toBe(true)
    expect(t.startVideo).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: { image: new Uint8Array([1, 2]), text: "Animate this" } })
    )
    expect(t.resolveStartFrame).toHaveBeenCalledWith(
      { kind: "media", ref: "cognia-media:abc" },
      origin
    )
    if (result.ok) {
      expect(result.job.request.startFrame).toEqual({ kind: "media", ref: "cognia-media:abc" })
    }
  })

  it("refuses without a network call: PII, empty prompt, bad option, no provider", async () => {
    const t = setup()
    await expect(
      t.engine.start({ prompt: "mail alice@example.com", origin })
    ).resolves.toMatchObject({ ok: false, error: { code: "pii_blocked" } })
    await expect(t.engine.start({ prompt: "  ", origin })).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported_input" },
    })
    await expect(
      t.engine.start({ prompt: "A boat", origin, params: { aspectRatio: "wide" as never } })
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported_input" } })
    t.setSettings({ defaultProvider: "replicate", providers: {}, customProviders: [] })
    await expect(t.engine.start({ prompt: "A boat", origin })).resolves.toMatchObject({
      ok: false,
      error: { code: "no_provider" },
    })
    expect(t.startVideo).not.toHaveBeenCalled()
  })

  it("screens vendor options and refuses ones that would replace the prompt", async () => {
    const t = setup()
    await expect(
      t.engine.start({
        prompt: "A boat",
        origin,
        providerOptions: { replicate: { negative_prompt: "mail alice@example.com" } },
      })
    ).resolves.toMatchObject({ ok: false, error: { code: "pii_blocked" } })
    await expect(
      t.engine.start({
        prompt: "A boat",
        origin,
        providerOptions: { replicate: { "alice@example.com": true } },
      })
    ).resolves.toMatchObject({ ok: false, error: { code: "pii_blocked" } })
    await expect(
      t.engine.start({ prompt: "A boat", origin, providerOptions: { fal: { prompt: "other" } } })
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported_input" } })
    expect(t.startVideo).not.toHaveBeenCalled()

    await t.engine.start({
      prompt: "A boat",
      origin,
      providerOptions: { replicate: { prompt_optimizer: true } },
    })
    expect(t.startVideo).toHaveBeenCalledWith(
      expect.objectContaining({ providerOptions: { replicate: { prompt_optimizer: true } } })
    )
  })

  it("holds a requested model id to an id's shape and to the PII gate", async () => {
    const t = setup()
    await expect(
      t.engine.start({ prompt: "A boat", origin, model: "video mail bob@example.com" })
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported_input" } })
    await expect(
      t.engine.start({ prompt: "A boat", origin, model: "video-4111111111111111" })
    ).resolves.toMatchObject({ ok: false, error: { code: "pii_blocked" } })
    expect(t.startVideo).not.toHaveBeenCalled()
  })

  it("scrubs URL queries and personal data out of stored provider text", async () => {
    const t = setup()
    await started(t)
    t.getVideoStatus.mockResolvedValue({
      status: "completed",
      videos: [{ type: "url", url: "https://cdn.test/v.mp4?key=secret", mediaType: "video/mp4" }],
      warnings: [],
      response: {},
    })
    t.fetch.mockRejectedValue(
      new Error("GET https://cdn.test/v.mp4?key=AIzaSecret failed for alice@example.com")
    )
    const row = await t.engine.poll("vjob_1")
    expect(row?.error?.code).toBe("download_failed")
    expect(row?.error?.message).toContain("https://cdn.test/v.mp4")
    expect(row?.error?.message).not.toContain("AIzaSecret")
    expect(row?.error?.message).not.toContain("alice@example.com")
  })

  it("refuses a non-image start frame", async () => {
    const t = setup({
      resolveStartFrame: async () => ({ data: new Uint8Array([1]), mediaType: "video/mp4" }),
    })
    await expect(
      t.engine.start({
        prompt: "A boat",
        origin,
        startFrame: { kind: "session-asset", assetId: "a1" },
      })
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported_input" } })
  })

  it("labels a provider the web build cannot reach instead of trying it", async () => {
    const t = setup({ reachesNonCorsHosts: () => false })
    await expect(t.engine.start({ prompt: "A boat", origin })).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable_on_web" },
    })
    expect(t.startVideo).not.toHaveBeenCalled()
  })

  it("falls through to a configured provider the web build can reach when none is named", async () => {
    const t = setup({ reachesNonCorsHosts: () => false })
    t.setSettings({
      defaultProvider: "replicate",
      providers: {
        replicate: { enabled: true, apiKey: "rep-key" },
        google: { enabled: true, apiKey: "g-key" },
      },
      customProviders: [],
    })
    const result = await t.engine.start({ prompt: "A boat", origin })
    expect(result).toMatchObject({ ok: true, job: { provider: { providerId: "google" } } })
    // A provider named explicitly is refused by name, not swapped.
    await expect(
      t.engine.start({ prompt: "A boat", origin, providerId: "replicate" })
    ).resolves.toMatchObject({ ok: false, error: { code: "unavailable_on_web" } })
  })

  it("reports a failed provider start without writing a row", async () => {
    const t = setup()
    t.startVideo.mockRejectedValueOnce(new Error("402 payment required"))
    await expect(t.engine.start({ prompt: "A boat", origin })).resolves.toMatchObject({
      ok: false,
      error: { code: "provider_error", message: "402 payment required" },
    })
    await expect(t.store.get("vjob_1")).resolves.toBeUndefined()
  })
})

describe("pollVideoJob", () => {
  it("backs off while pending and clears a transient error on the next answer", async () => {
    const t = setup()
    await started(t)
    t.getVideoStatus.mockRejectedValueOnce(new Error("socket hang up"))
    const afterError = await t.engine.poll("vjob_1")
    expect(afterError).toMatchObject({
      status: "generating",
      pollCount: 1,
      lastPollError: "socket hang up",
    })

    t.getVideoStatus.mockResolvedValueOnce({ status: "pending", response: {} })
    const pending = await t.engine.poll("vjob_1")
    expect(pending?.status).toBe("generating")
    expect(pending?.lastPollError).toBeUndefined()
    expect(pending!.nextPollAt).toBeGreaterThan(NOW)
  })

  it("downloads a completed video once and stores it", async () => {
    const t = setup()
    await started(t)
    t.getVideoStatus.mockResolvedValue({
      status: "completed",
      videos: [{ type: "url", url: "https://cdn.test/v.mp4", mediaType: "video/mp4" }],
      warnings: [],
      response: {},
    })
    t.fetch.mockResolvedValue(new Response(new Blob([new Uint8Array(10)], { type: "video/mp4" })))

    const done = await t.engine.poll("vjob_1")
    expect(t.fetch).toHaveBeenCalledWith(
      "https://cdn.test/v.mp4",
      expect.objectContaining({ binaryResponse: true })
    )
    expect(done).toMatchObject({
      status: "succeeded",
      result: { content: { kind: "library", assetId: "asset-vjob_1" }, byteSize: 10 },
    })
    // A second poll of a settled job is a no-op.
    await t.engine.poll("vjob_1")
    expect(t.materialize).toHaveBeenCalledTimes(1)
  })

  it("only one of two concurrent polls downloads", async () => {
    const t = setup()
    await started(t)
    t.getVideoStatus.mockResolvedValue({
      status: "completed",
      videos: [{ type: "base64", data: "AAEC", mediaType: "video/mp4" }],
      warnings: [],
      response: {},
    })
    await Promise.all([t.engine.poll("vjob_1"), t.engine.poll("vjob_1")])
    expect(t.materialize).toHaveBeenCalledTimes(1)
  })

  it("settles provider failures, oversize and expired results with their codes", async () => {
    const t = setup()
    await started(t)
    t.getVideoStatus.mockResolvedValueOnce({ status: "error", error: "flagged", response: {} })
    await expect(t.engine.poll("vjob_1")).resolves.toMatchObject({
      status: "failed",
      error: { code: "generation_failed", message: "flagged", recheckable: false },
    })

    for (const [response, code, recheckable] of [
      [new Response("gone", { status: 410 }), "result_expired", false],
      [new Response("x", { status: 500 }), "download_failed", true],
      [
        new Response("x", { status: 200, headers: { "content-length": "5000" } }),
        "result_too_large",
        false,
      ],
    ] as const) {
      const u = setup()
      await started(u)
      u.getVideoStatus.mockResolvedValue({
        status: "completed",
        videos: [{ type: "url", url: "https://cdn.test/v.mp4", mediaType: "video/mp4" }],
        warnings: [],
        response: {},
      })
      u.fetch.mockResolvedValue(response)
      await expect(u.engine.poll("vjob_1")).resolves.toMatchObject({
        status: "failed",
        error: { code, recheckable },
      })
    }
  })

  it("maps the desktop bridge's size refusal to result_too_large", async () => {
    const t = setup()
    await started(t)
    t.getVideoStatus.mockResolvedValue({
      status: "completed",
      videos: [{ type: "url", url: "https://cdn.test/v.mp4", mediaType: "video/mp4" }],
      warnings: [],
      response: {},
    })
    t.fetch.mockRejectedValue(new Error(`Proxy request failed: ${PROXY_BODY_LIMIT_MESSAGE}`))
    await expect(t.engine.poll("vjob_1")).resolves.toMatchObject({
      error: { code: "result_too_large" },
    })
  })

  it("times out past the deadline without asking the provider again", async () => {
    const t = setup()
    await started(t)
    t.advance(VIDEO_JOB_DEADLINE_MS)
    await expect(t.engine.poll("vjob_1")).resolves.toMatchObject({
      status: "timed_out",
      error: { code: "timed_out", recheckable: true },
    })
    expect(t.getVideoStatus).not.toHaveBeenCalled()
  })

  it("stops checking with a changed API key (recheckable)", async () => {
    const t = setup()
    await started(t)
    t.setSettings(snapshot("another-key"))
    await expect(t.engine.poll("vjob_1")).resolves.toMatchObject({
      status: "failed",
      error: { code: "credential_changed", recheckable: true },
    })
    expect(t.getVideoStatus).not.toHaveBeenCalled()
  })
})

describe("recheckVideoJob", () => {
  it("reopens a timed-out job with a fresh deadline and checks it at once", async () => {
    const t = setup()
    await started(t)
    t.advance(VIDEO_JOB_DEADLINE_MS)
    await t.engine.poll("vjob_1")
    expect(t.getVideoStatus).not.toHaveBeenCalled()

    t.getVideoStatus.mockResolvedValueOnce({ status: "pending", response: {} })
    const reopened = await t.engine.recheck("vjob_1")
    expect(reopened).toMatchObject({ status: "generating", pollCount: 1 })
    expect(reopened?.error).toBeUndefined()
    expect(reopened?.settledAt).toBeUndefined()
    expect(reopened!.deadlineAt).toBeGreaterThan(t.now() + VIDEO_JOB_DEADLINE_MS - 1000)
  })

  it("picks up a credential-changed job once the original key is back", async () => {
    const t = setup()
    await started(t)
    t.setSettings(snapshot("another-key"))
    await t.engine.poll("vjob_1")
    t.setSettings(snapshot())
    t.getVideoStatus.mockResolvedValueOnce({ status: "pending", response: {} })
    await expect(t.engine.recheck("vjob_1")).resolves.toMatchObject({ status: "generating" })
  })

  it("leaves jobs alone that cannot succeed by asking again", async () => {
    const t = setup()
    await started(t)
    t.getVideoStatus.mockResolvedValueOnce({ status: "error", error: "flagged", response: {} })
    await t.engine.poll("vjob_1")
    t.getVideoStatus.mockClear()
    await expect(t.engine.recheck("vjob_1")).resolves.toMatchObject({
      status: "failed",
      error: { code: "generation_failed" },
    })
    expect(t.getVideoStatus).not.toHaveBeenCalled()
  })
})

describe("cancelVideoJob", () => {
  it("asks a provider with a cancel endpoint to stop", async () => {
    const t = setup()
    await started(t)
    t.fetch.mockResolvedValue(new Response("{}", { status: 200 }))
    await expect(t.engine.cancel("vjob_1")).resolves.toMatchObject({
      status: "cancelled",
      remoteCancelled: true,
    })
    expect(t.fetch).toHaveBeenCalledWith(
      "https://api.replicate.com/v1/predictions/p1/cancel",
      expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer rep-key" } })
    )
  })

  it("records a local-only stop when the provider refuses or has no cancel", async () => {
    const t = setup()
    await started(t)
    t.fetch.mockResolvedValue(new Response("no", { status: 409 }))
    await expect(t.engine.cancel("vjob_1")).resolves.toMatchObject({
      status: "cancelled",
      remoteCancelled: false,
    })
  })
})

describe("waitForVideoJob", () => {
  it("polls on the job's schedule until it settles", async () => {
    const t = setup()
    await started(t)
    t.getVideoStatus
      .mockResolvedValueOnce({ status: "pending", response: {} })
      .mockResolvedValueOnce({
        status: "completed",
        videos: [{ type: "binary", data: new Uint8Array([7]), mediaType: "video/mp4" }],
        warnings: [],
        response: {},
      })
    const sleep = jest.fn(async (ms: number) => t.advance(ms))
    const settled = await t.engine.wait("vjob_1", { sleep })
    expect(settled?.status).toBe("succeeded")
    expect(sleep).toHaveBeenCalled()
  })

  it("cancels the job when the caller aborts", async () => {
    const t = setup()
    await started(t)
    const controller = new AbortController()
    controller.abort()
    t.fetch.mockResolvedValue(new Response("{}", { status: 200 }))
    await expect(t.engine.wait("vjob_1", { signal: controller.signal })).resolves.toMatchObject({
      status: "cancelled",
    })
  })
})
