/** @jest-environment node */
import type { ProviderResourceHandle } from "@cognia/provider-types"
import { createInMemoryMediaJobStore } from "@/lib/ai/media/video-jobs/store"
import type { MediaGenerationJobRow } from "@/lib/ai/media/video-jobs/types"

const store = createInMemoryMediaJobStore()
const engine = { poll: jest.fn(), cancel: jest.fn() }
const readContent = jest.fn()
jest.mock("@/lib/ai/media/video-jobs/host", () => ({
  getVideoJobEngine: () => engine,
  getVideoJobHost: () => ({ store, readContent }),
}))

import {
  cancelVideoJob,
  contractStatusOf,
  failureOfVideoJobError,
  getVideoJob,
  isVideoJobHandle,
  videoJobContent,
} from "./video-job-bridge"

const settings = { defaultProvider: "google", providers: {}, customProviders: [] }
const handle = (id: string, providerId = "google"): ProviderResourceHandle => ({
  kind: "video",
  id,
  providerId,
  deploymentRef: providerId,
  accountRef: "a",
  credentialAffinity: "a",
})

function job(id: string, overrides: Partial<MediaGenerationJobRow> = {}): MediaGenerationJobRow {
  return {
    id,
    kind: "video",
    origin: { surface: "executor" },
    request: { prompt: "p" },
    provider: { providerId: "google", modelId: "veo", credentialAffinity: "a" },
    operation: {},
    status: "generating",
    pollCount: 0,
    nextPollAt: 0,
    deadlineAt: 10,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

beforeEach(() => jest.clearAllMocks())

describe("video job bridge", () => {
  it("recognises job handles and maps statuses to the contract", () => {
    expect(isVideoJobHandle({ id: "vjob_1" })).toBe(true)
    expect(isVideoJobHandle({ id: "local-1" })).toBe(false)
    expect(contractStatusOf("generating")).toBe("running")
    expect(contractStatusOf("downloading")).toBe("running")
    expect(contractStatusOf("timed_out")).toBe("failed")
    expect(contractStatusOf("cancelled")).toBe("cancelled")
  })

  it("maps start refusals to typed failures", () => {
    expect(
      failureOfVideoJobError({ code: "pii_blocked", message: "m", recheckable: false }).failure.code
    ).toBe("permission")
    expect(
      failureOfVideoJobError({ code: "unavailable_on_web", message: "m", recheckable: false })
        .failure.code
    ).toBe("capability-unsupported")
    expect(
      failureOfVideoJobError({ code: "provider_error", message: "m", recheckable: true }).failure
    ).toMatchObject({ code: "transport", retryable: true })
  })

  it("checks a generating job with the provider on videos.get", async () => {
    await store.insert(job("vjob_get"))
    engine.poll.mockResolvedValueOnce(job("vjob_get", { status: "succeeded" }))
    await expect(getVideoJob(handle("vjob_get"), settings)).resolves.toMatchObject({
      status: "succeeded",
      progress: 1,
    })
    expect(engine.poll).toHaveBeenCalledWith("vjob_get", { snapshot: settings })
  })

  it("refuses a job that belongs to another provider", async () => {
    await store.insert(job("vjob_other"))
    await expect(getVideoJob(handle("vjob_other", "xai"), settings)).rejects.toMatchObject({
      failure: { code: "model-unavailable" },
    })
  })

  it("cancels through the engine and reports the settled status with its error", async () => {
    await store.insert(job("vjob_cancel"))
    engine.cancel.mockResolvedValueOnce(job("vjob_cancel", { status: "cancelled" }))
    await expect(cancelVideoJob(handle("vjob_cancel"), settings)).resolves.toMatchObject({
      status: "cancelled",
    })
    await store.insert(
      job("vjob_failed", {
        status: "failed",
        error: { code: "generation_failed", message: "flagged", recheckable: false },
      })
    )
    engine.cancel.mockResolvedValueOnce(undefined)
    await expect(cancelVideoJob(handle("vjob_failed"), settings)).resolves.toMatchObject({
      status: "failed",
      error: "generation_failed: flagged",
    })
  })

  it("returns a finished video's bytes and refuses one that is not finished", async () => {
    await store.insert(
      job("vjob_done", {
        status: "succeeded",
        result: {
          content: { kind: "inline", bytes: new Uint8Array([1]) },
          mediaType: "video/mp4",
          byteSize: 1,
        },
      })
    )
    readContent.mockResolvedValueOnce(new Blob([new Uint8Array([9, 8])]))
    await expect(videoJobContent(handle("vjob_done"), settings)).resolves.toMatchObject({
      base64: "CQg=",
      mimeType: "video/mp4",
    })
    await store.insert(job("vjob_running"))
    engine.poll.mockResolvedValueOnce(job("vjob_running"))
    await expect(videoJobContent(handle("vjob_running"), settings)).rejects.toMatchObject({
      failure: { code: "model-unavailable", retryable: true },
    })
  })
})
