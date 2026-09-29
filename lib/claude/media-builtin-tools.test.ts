import type { UIMessage } from "ai"

import type { MediaGenerationJobRow } from "@/lib/ai/media/video-jobs/types"
import {
  MEDIA_BUILTIN_PLUGIN_ID,
  MEDIA_TOOL_NAMES,
  buildMediaManifestEntries,
  isMediaBuiltinTool,
  runMediaBuiltinTool,
  type MediaToolDeps,
} from "./media-builtin-tools"

function job(overrides: Partial<MediaGenerationJobRow> = {}): MediaGenerationJobRow {
  return {
    id: "vjob_1",
    kind: "video",
    sessionId: "s1",
    origin: { surface: "chat-tool", sessionId: "s1" },
    request: { prompt: "A paper boat" },
    provider: { providerId: "doubao", modelId: "seedance-1-5-pro-251215", credentialAffinity: "a" },
    operation: { taskId: "t1" },
    status: "generating",
    pollCount: 0,
    nextPollAt: 0,
    deadlineAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function deps(overrides: Partial<MediaToolDeps> = {}) {
  const start = jest.fn<ReturnType<MediaToolDeps["start"]>, Parameters<MediaToolDeps["start"]>>(
    async () => ({ ok: true, job: job() })
  )
  const value: MediaToolDeps = {
    start,
    getJob: jest.fn(async () => undefined),
    settings: () => ({ agentTool: true, providerId: "doubao", durationSec: 5 }),
    configuredProviders: () => ["doubao"],
    listMessages: jest.fn(async () => []),
    projectIdOf: jest.fn(async () => "p1"),
    ...overrides,
  }
  return { deps: value, start }
}

const context = { sessionId: "s1" }

describe("media built-in tool manifest", () => {
  it("ships video_generate and video_status under one plugin id", () => {
    const entries = buildMediaManifestEntries()
    expect(entries.map((entry) => entry.name)).toEqual([...MEDIA_TOOL_NAMES])
    for (const entry of entries) {
      expect(entry.pluginId).toBe(MEDIA_BUILTIN_PLUGIN_ID)
      expect(isMediaBuiltinTool(entry.name)).toBe(true)
    }
    expect(isMediaBuiltinTool("image_generate")).toBe(false)
  })
})

describe("video_generate", () => {
  it("starts a chat job with the saved defaults and returns its id at once", async () => {
    const t = deps()
    const result = await runMediaBuiltinTool(
      "video_generate",
      { prompt: "A boat" },
      t.deps,
      context
    )
    expect(t.start).toHaveBeenCalledWith({
      prompt: "A boat",
      providerId: "doubao",
      params: { durationSec: 5 },
      origin: { surface: "chat-tool", sessionId: "s1" },
      projectId: "p1",
    })
    expect(result).toEqual({
      ok: true,
      jobId: "vjob_1",
      status: "generating",
      providerId: "doubao",
      model: "seedance-1-5-pro-251215",
    })
    // The agent wrote the prompt; echoing it back only costs context.
    expect(JSON.stringify(result)).not.toContain("paper boat")
  })

  it("lets the call override a default", async () => {
    const t = deps()
    await runMediaBuiltinTool(
      "video_generate",
      { prompt: "A boat", durationSec: 10, aspectRatio: "9:16" },
      t.deps,
      context
    )
    expect(t.start.mock.calls[0]![0].params).toEqual({ durationSec: 10, aspectRatio: "9:16" })
  })

  it("resolves the latest image in the conversation as the start frame", async () => {
    const messages = [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "file", mediaType: "image/png", url: "cognia-media:old" }],
      },
      {
        id: "m2",
        role: "user",
        parts: [
          { type: "file", mediaType: "application/pdf", url: "cognia-media:doc" },
          { type: "file", mediaType: "image/jpeg", url: "cognia-media:new" },
          { type: "text", text: "animate this" },
        ],
      },
    ] as unknown as UIMessage[]
    const t = deps({ listMessages: jest.fn(async () => messages) })
    await runMediaBuiltinTool(
      "video_generate",
      { prompt: "Move", image: "latest" },
      t.deps,
      context
    )
    expect(t.start.mock.calls[0]![0].startFrame).toEqual({ kind: "media", ref: "cognia-media:new" })
  })

  it("passes a media reference or an attachment id through to the engine's resolver", async () => {
    const t = deps()
    await runMediaBuiltinTool(
      "video_generate",
      { prompt: "Move", image: "cognia-media:abc" },
      t.deps,
      context
    )
    await runMediaBuiltinTool("video_generate", { prompt: "Move", image: "att_9" }, t.deps, context)
    expect(t.start.mock.calls[0]![0].startFrame).toEqual({ kind: "media", ref: "cognia-media:abc" })
    expect(t.start.mock.calls[1]![0].startFrame).toEqual({
      kind: "session-asset",
      assetId: "att_9",
    })
  })

  it("refuses without starting when there is no image, prompt or session", async () => {
    const t = deps()
    await expect(
      runMediaBuiltinTool("video_generate", { prompt: "Move", image: "latest" }, t.deps, context)
    ).resolves.toMatchObject({ ok: false, code: "no_image" })
    await expect(
      runMediaBuiltinTool("video_generate", { prompt: "  " }, t.deps, context)
    ).resolves.toMatchObject({ ok: false, code: "invalid_arguments" })
    await expect(
      runMediaBuiltinTool("video_generate", { prompt: "x" }, t.deps, { sessionId: "" })
    ).resolves.toMatchObject({ ok: false, code: "session_required" })
    expect(t.start).not.toHaveBeenCalled()
  })

  it("hands the engine's refusal to the model with its code", async () => {
    const t = deps({
      start: jest.fn(async () => ({
        ok: false as const,
        error: { code: "pii_blocked" as const, message: "blocked", recheckable: false },
      })),
    })
    await expect(
      runMediaBuiltinTool("video_generate", { prompt: "x" }, t.deps, context)
    ).resolves.toEqual({ ok: false, code: "pii_blocked", error: "blocked" })
  })

  it("never throws", async () => {
    const t = deps({ projectIdOf: jest.fn(async () => Promise.reject(new Error("db closed"))) })
    await expect(
      runMediaBuiltinTool("video_generate", { prompt: "x" }, t.deps, context)
    ).resolves.toEqual({ ok: false, code: "internal_error", error: "db closed" })
  })
})

describe("video_status", () => {
  it("reports a finished job's video without the prompt", async () => {
    const row = job({
      status: "succeeded",
      result: {
        content: { kind: "session-asset", sessionId: "s1", assetId: "video-vjob_1" },
        mediaType: "video/mp4",
        byteSize: 2048,
        durationSec: 5,
        width: 1280,
        height: 720,
      },
    })
    const t = deps({ getJob: jest.fn(async () => row) })
    const result = await runMediaBuiltinTool("video_status", { jobId: "vjob_1" }, t.deps, context)
    expect(result).toEqual({
      ok: true,
      jobId: "vjob_1",
      status: "succeeded",
      providerId: "doubao",
      model: "seedance-1-5-pro-251215",
      video: { mediaType: "video/mp4", byteSize: 2048, durationSec: 5, width: 1280, height: 720 },
    })
  })

  it("reports a failure code and whether a cancel reached the provider", async () => {
    const failed = job({
      status: "failed",
      error: { code: "generation_failed", message: "flagged", recheckable: false },
    })
    const cancelled = job({ status: "cancelled", remoteCancelled: false })
    const t = deps({
      getJob: jest.fn(async (id: string) => (id === "a" ? failed : cancelled)),
    })
    await expect(
      runMediaBuiltinTool("video_status", { jobId: "a" }, t.deps, context)
    ).resolves.toMatchObject({ status: "failed", code: "generation_failed", error: "flagged" })
    await expect(
      runMediaBuiltinTool("video_status", { jobId: "b" }, t.deps, context)
    ).resolves.toMatchObject({ status: "cancelled", remoteCancelled: false })
  })

  it("redacts personal data a stored provider message still carries", async () => {
    const row = job({
      status: "failed",
      error: {
        code: "provider_error",
        message: "rejected for alice@example.com",
        recheckable: true,
      },
      warnings: ["seed ignored for alice@example.com"],
    })
    const t = deps({ getJob: jest.fn(async () => row) })
    const result = (await runMediaBuiltinTool(
      "video_status",
      { jobId: "vjob_1" },
      t.deps,
      context
    )) as { error: string; warnings: string[] }
    expect(result.error).not.toContain("alice@example.com")
    expect(result.warnings[0]).not.toContain("alice@example.com")
  })

  it("does not read another conversation's job", async () => {
    const t = deps({ getJob: jest.fn(async () => job({ sessionId: "other" })) })
    await expect(
      runMediaBuiltinTool("video_status", { jobId: "vjob_1" }, t.deps, context)
    ).resolves.toMatchObject({ ok: false, code: "not_found" })
  })
})
