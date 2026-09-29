import { retryInputOf } from "./retry"
import type { MediaGenerationJobRow } from "./types"

function row(overrides: Partial<MediaGenerationJobRow> = {}): MediaGenerationJobRow {
  return {
    id: "vjob_1",
    kind: "video",
    sessionId: "s1",
    projectId: "p1",
    origin: { surface: "chat-tool", sessionId: "s1" },
    request: {
      prompt: "A paper boat",
      startFrame: { kind: "session-asset", assetId: "video-frame-1" },
      durationSec: 5,
      aspectRatio: "16:9",
    },
    provider: { providerId: "doubao", modelId: "seedance-1-5-pro-251215", credentialAffinity: "a" },
    operation: {},
    status: "failed",
    error: { code: "generation_failed", message: "flagged", recheckable: false },
    pollCount: 1,
    nextPollAt: 0,
    deadlineAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe("retryInputOf", () => {
  it("repeats the request on the same provider and model from the same conversation", () => {
    expect(retryInputOf(row())).toEqual({
      prompt: "A paper boat",
      startFrame: { kind: "session-asset", assetId: "video-frame-1" },
      providerId: "doubao",
      model: "seedance-1-5-pro-251215",
      params: { durationSec: 5, aspectRatio: "16:9" },
      origin: { surface: "chat-tool", sessionId: "s1" },
      projectId: "p1",
    })
    expect(retryInputOf(row({ origin: { surface: "slash", sessionId: "s1" } }))?.origin).toEqual({
      surface: "slash",
      sessionId: "s1",
    })
  })

  it("repeats cancelled and timed-out jobs too", () => {
    expect(retryInputOf(row({ status: "cancelled", error: undefined }))).not.toBeNull()
    expect(retryInputOf(row({ status: "timed_out" }))).not.toBeNull()
  })

  it("does not repeat a running or finished job", () => {
    expect(retryInputOf(row({ status: "generating", error: undefined }))).toBeNull()
    expect(retryInputOf(row({ status: "downloading", error: undefined }))).toBeNull()
    expect(retryInputOf(row({ status: "succeeded", error: undefined }))).toBeNull()
  })

  it("cannot repeat a job whose start frame was never stored, or one started outside a chat", () => {
    expect(
      retryInputOf(
        row({ request: { prompt: "x", startFrame: { kind: "inline", mediaType: "image/png" } } })
      )
    ).toBeNull()
    expect(retryInputOf(row({ origin: { surface: "plugin", pluginId: "p" } }))).toBeNull()
    expect(retryInputOf(row({ origin: { surface: "executor" } }))).toBeNull()
  })
})
