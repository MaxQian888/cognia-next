import {
  processAttachmentMedia,
  restoreDerivedAttachment,
  type AttachmentMediaDeps,
} from "./media-extraction"
import type { ExtractedAttachment } from "./dispatch"
import { estimateFallbackTokens } from "@/lib/ai/tokens/fallback-estimator"

const mockExecute = jest.fn()
jest.mock("@/lib/ai/operations", () => ({
  getProviderOperationExecutor: () => ({ execute: mockExecute }),
}))

jest.mock("./video/ffmpeg-source", () => ({
  canUseLocalFfmpeg: () => false,
  openFfmpegVideoSource: jest.fn(),
}))

const options = { method: "transcribe" as const, providerId: "configured", modelId: "transcriber" }
const source = (): ExtractedAttachment => ({
  kind: "audio",
  block: null,
  tokens: 0,
  original: new Blob(["audio"], { type: "audio/wav" }),
  extractedContent: {
    attachmentId: "a",
    contentHash: "a".repeat(64),
    status: "partial",
    segments: [],
    processor: { id: "source", version: "1" },
  },
})
const videoPayload = (): NonNullable<ExtractedAttachment["video"]> => ({
  sampled: {
    blocks: [],
    tokens: 0,
    info: {
      groupId: "a",
      filename: "clip.mp4",
      sourceMediaType: "video/mp4",
      kind: "video",
      durationSec: 10,
      width: 640,
      height: 360,
      delivery: "frames",
      strategy: "uniform",
      range: null,
      frameTimes: [],
      engine: "ffmpeg",
    },
  },
  native: null,
  poster: { mediaType: "image/jpeg", base64: "YQ==", width: 1, height: 1 },
})
const deps = (output: unknown): AttachmentMediaDeps => ({
  executor: { execute: jest.fn().mockResolvedValue({ ok: true, output }) },
  canUseFfmpeg: () => false,
  openVideo: jest.fn(),
})

it("transcribes through the operation boundary and retains source timestamps", async () => {
  const services = deps({
    text: "We chose B",
    segments: [{ text: "We chose B", start: 2, end: 6 }],
  })
  const result = await processAttachmentMedia(source(), "meeting.wav", options, services)
  expect(result.extractedContent?.segments[0]).toMatchObject({
    derivation: "transcription",
    locator: { type: "time", startSec: 2, endSec: 6 },
  })
  expect(result.block).toMatchObject({ type: "text" })
  expect(services.executor.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      operationId: "transcription.create",
      providerId: "configured",
      input: expect.objectContaining({ model: "transcriber" }),
    }),
    expect.objectContaining({ signal: expect.anything() })
  )
})

it("refuses invalid timestamps instead of fabricating evidence", async () => {
  const result = await processAttachmentMedia(
    source(),
    "a.wav",
    options,
    deps({ text: "hello", segments: [{ text: "hello", start: 8, end: 2 }] })
  )
  expect(result.extractedContent?.status).toBe("failed")
  expect(result.block).toBeNull()
})

it("does not call a provider without an explicit model", async () => {
  const services = deps({ text: "hello" })
  await expect(
    processAttachmentMedia(source(), "a.wav", { ...options, modelId: "" }, services)
  ).rejects.toThrow("attachment_model_required")
  expect(services.executor.execute).not.toHaveBeenCalled()
})

it("cancels before any provider work", async () => {
  const controller = new AbortController()
  controller.abort()
  const services = deps({ text: "hello" })
  await expect(
    processAttachmentMedia(source(), "a.wav", { ...options, signal: controller.signal }, services)
  ).rejects.toMatchObject({ name: "AbortError" })
  expect(services.executor.execute).not.toHaveBeenCalled()
})

it("marks vision output as derived and partial when output is limited", async () => {
  const attachment = {
    ...source(),
    kind: "image" as const,
    block: {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/png", data: "YQ==" },
    },
  }
  const result = await processAttachmentMedia(
    attachment,
    "chart.png",
    { ...options, method: "describe" },
    deps({ text: "Two labeled bars", finishReason: "length" })
  )
  expect(result.extractedContent?.segments[0]).toMatchObject({
    derivation: "description",
    locator: { type: "image" },
  })
  expect(result.extractedContent?.status).toBe("partial")
  expect(result.extractedContent?.issues).toContain("description-output-limited:0")
})

it("catches cancellation while resolving the operation executor", async () => {
  const controller = new AbortController()
  const pending = processAttachmentMedia(source(), "a.wav", {
    ...options,
    signal: controller.signal,
  })
  controller.abort()
  const result = await pending
  expect(result.extractedContent?.status).toBe("cancelled")
  expect(mockExecute).not.toHaveBeenCalled()
})

it("retains successful source evidence after a failed retry and keeps unrelated coverage issues", async () => {
  const attachment = source()
  attachment.extractedContent!.segments = [
    {
      id: "transcription-0",
      text: "Existing transcript",
      derivation: "transcription",
      locator: { type: "time", startSec: 0, endSec: 5 },
    },
  ]
  attachment.extractedContent!.issues = [
    "transcription-required",
    "audio-not-transcribed",
    "visual-content-not-indexed",
  ]
  const services = deps({})
  jest.mocked(services.executor.execute).mockRejectedValue(new Error("provider unavailable"))
  const failed = await processAttachmentMedia(attachment, "a.wav", options, services)
  expect(failed.extractedContent?.segments).toEqual(attachment.extractedContent!.segments)
  expect(failed.extractedContent?.status).toBe("partial")
  expect(failed.extractedContent?.issues).toContain("transcription-required")
  const success = await processAttachmentMedia(
    attachment,
    "a.wav",
    options,
    deps({ text: "Updated transcript" })
  )
  expect(success.extractedContent?.issues).toEqual(["visual-content-not-indexed"])
})

it("preserves non-text token costs when replacing derived image and video text", () => {
  const attachment = source()
  const extractedContent = {
    ...attachment.extractedContent!,
    segments: [
      {
        id: "d",
        text: "A chart",
        derivation: "description" as const,
        locator: { type: "image" as const },
      },
    ],
  }
  const image = restoreDerivedAttachment(
    { ...attachment, kind: "image", tokens: 1500, ocr: { text: "previous", tokens: 10 } },
    extractedContent,
    "chart.png"
  )
  expect(image.tokens).toBe(1490 + image.ocr!.tokens)
  const oldText = "Derived previous text"
  const video = restoreDerivedAttachment(
    {
      ...attachment,
      kind: "video",
      video: {
        ...videoPayload(),
        sampled: {
          ...videoPayload().sampled,
          tokens: 2000,
          blocks: [{ type: "text", text: oldText }],
        },
      },
    },
    extractedContent,
    "clip.mp4"
  )
  const updatedText = video.video!.sampled.blocks.find((block) => block.type === "text")!
  expect(video.video!.sampled.tokens).toBe(
    2000 -
      estimateFallbackTokens(oldText) +
      estimateFallbackTokens((updatedText as { text: string }).text)
  )
})

it("retains completed transcripts when local source cleanup fails", async () => {
  const attachment: ExtractedAttachment = {
    ...source(),
    kind: "video" as const,
    original: new Blob([new Uint8Array(11 * 1024 * 1024)]),
    video: videoPayload(),
  }
  const services = deps({ text: "Completed transcript" })
  services.canUseFfmpeg = () => true
  services.openVideo = jest.fn().mockResolvedValue({
    info: { durationSec: 10 },
    readNative: async () => ({ bytes: new Uint8Array([1]) }),
    close: async () => {
      throw new Error("cleanup failed")
    },
  })
  const result = await processAttachmentMedia(attachment, "clip.mp4", options, services)
  expect(result.extractedContent?.segments[0]?.text).toBe("Completed transcript")
  expect(result.extractedContent?.issues).toContain("media-source-cleanup-failed")
})
