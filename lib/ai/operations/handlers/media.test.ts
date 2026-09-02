/** @jest-environment node */
jest.mock("./ai-sdk-surface", () => ({
  generateImageGated: jest.fn(),
  generateVideoGated: jest.fn(),
  generateSpeechGated: jest.fn(),
  transcribeGated: jest.fn(),
}))
const surface = jest.requireMock("./ai-sdk-surface") as Record<string, jest.Mock>
jest.mock("@/lib/ai/media/provider-generation", () => ({
  IMAGE_GENERATION_PROVIDER_IDS: ["openai", "google"],
  generateProviderImage: jest.fn(),
  generateProviderVideo: jest.fn(),
}))
const media = jest.requireMock("@/lib/ai/media/provider-generation") as {
  generateProviderImage: jest.Mock
  generateProviderVideo: jest.Mock
}
jest.mock("@/lib/ai/media/video-generation-sdk", () => ({
  VIDEO_GENERATION_PROVIDER_IDS: ["google"],
}))
const client: Record<string, unknown> = {}
jest.mock("@/lib/ai/provider-consumption", () => ({ createFeatureProviderClient: () => client }))

import {
  imagesGenerateOutput,
  speechGenerateOutput,
  transcriptionCreateOutput,
  videosGenerateOutput,
  type ProviderOperationId,
} from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { providerJobRegistry } from "../job-handle"
import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import { MEDIA_HANDLERS, speechGenerateHandler, transcriptionCreateHandler } from "./media"

const provider: ResolvedProvider = {
  kind: "resolved",
  providerId: "openai",
  protocol: "openai",
  apiKey: "k",
  baseURL: "https://a/v1",
  model: "configured",
  isCustomProvider: false,
  useProxy: false,
}
const settings = { defaultProvider: "openai", providers: {}, customProviders: [] }
const registry = new ProviderOperationHandlerRegistry()
for (const handler of MEDIA_HANDLERS) registry.register(handler)

function ctx<T>(operationId: ProviderOperationId, input: T, resolved = provider) {
  return {
    descriptor: getProviderOperationDescriptor(operationId)!,
    provider: resolved,
    settings,
    request: {
      operationId,
      scopes: ["provider:invoke" as const],
      surface: "sidecar" as const,
      input,
      deploymentRef: "dep-1",
    },
  }
}

describe("media handlers", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    providerJobRegistry.clear()
    for (const key of Object.keys(client)) delete client[key]
  })

  it("routes a media-module vendor through the shared generator and everyone else through the SDK client", async () => {
    media.generateProviderImage.mockResolvedValueOnce({
      images: [{ base64: "aa", mediaType: "image/png" }],
    })
    const viaModule = registry.resolve("images.generate", "openai", "openai")!
    const output = await viaModule.handler(
      ctx("images.generate", { model: "img", prompt: "cat", size: "1024x1024", extra: { seed: 7 } })
    )
    expect(imagesGenerateOutput.parse(output)).toEqual({
      images: [{ base64: "aa", mimeType: "image/png" }],
    })
    expect(media.generateProviderImage).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: settings,
        providerId: "openai",
        prompt: "cat",
        size: "1024x1024",
        seed: 7,
      })
    )
    await expect(
      viaModule.handler(ctx("images.generate", { model: "img", prompt: "cat", size: "big" }))
    ).rejects.toThrow(/size must look like/)

    const other = { ...provider, providerId: "xyz-compatible" }
    const viaSdk = registry.resolve("images.generate", "xyz-compatible", "openai")!
    expect(viaSdk.providerMatch).toEqual({ kind: "any" })
    await expect(
      viaSdk.handler(ctx("images.generate", { model: "img", prompt: "cat" }, other))
    ).rejects.toThrow(/no image model factory/)
    client.imageModel = (id: string) => ({ id })
    surface.generateImageGated.mockResolvedValueOnce({
      images: [{ base64: "bb", mediaType: "image/webp" }],
    })
    await expect(
      viaSdk.handler(ctx("images.generate", { model: "img", prompt: "cat" }, other))
    ).resolves.toEqual({
      images: [{ base64: "bb", mimeType: "image/webp" }],
    })
  })

  it("records a generated video as a locally completed job under a pinned handle", async () => {
    media.generateProviderVideo.mockResolvedValueOnce({
      videos: [{ base64: "vv", mediaType: "video/mp4" }],
    })
    const google = { ...provider, providerId: "google", protocol: "google" as const }
    const output = (await registry
      .resolve("videos.generate", "google", "google")!
      .handler(
        ctx(
          "videos.generate",
          { model: "veo", prompt: "dog", durationSeconds: 4, extra: { resolution: "1280x720" } },
          google
        )
      )) as {
      handle: {
        kind: string
        providerId: string
        deploymentRef: string
        credentialAffinity: string
      }
      status: string
    }
    expect(media.generateProviderVideo).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 4, resolution: "1280x720", providerId: "google" })
    )
    expect(videosGenerateOutput.parse(output)).toMatchObject({ status: "succeeded" })
    expect(output.handle).toMatchObject({
      kind: "video",
      providerId: "google",
      deploymentRef: "dep-1",
    })
    expect(output.handle.credentialAffinity).not.toContain("k")
    const job = providerJobRegistry.get(output.handle as never)
    expect(job?.status).toBe("succeeded")
    expect(job?.content).toEqual({ base64: "vv", mimeType: "video/mp4" })
  })

  it("speaks and transcribes through the client's optional factories", async () => {
    client.speechModel = (id: string) => ({ id })
    surface.generateSpeechGated.mockResolvedValueOnce({
      audio: { base64: "ss", mediaType: "audio/mpeg" },
    })
    const speech = await speechGenerateHandler.handler(
      ctx("speech.generate", {
        model: "tts",
        text: "hi",
        voice: "alloy",
        format: "mp3",
        extra: { speed: 1.2 },
      })
    )
    expect(speechGenerateOutput.parse(speech)).toEqual({
      audio: { base64: "ss", mimeType: "audio/mpeg" },
    })
    expect(surface.generateSpeechGated).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: "tts" },
        text: "hi",
        voice: "alloy",
        outputFormat: "mp3",
        speed: 1.2,
      })
    )

    client.transcriptionModel = (id: string) => ({ id })
    surface.transcribeGated.mockResolvedValueOnce({
      text: "hello",
      language: "en",
      durationInSeconds: 1.5,
      segments: [{ text: "hello", startSecond: 0, endSecond: 1.5 }],
    })
    const transcript = await transcriptionCreateHandler.handler(
      ctx("transcription.create", { model: "w", audio: { base64: "AAAA", mimeType: "audio/wav" } })
    )
    expect(transcriptionCreateOutput.parse(transcript)).toEqual({
      text: "hello",
      language: "en",
      segments: [{ start: 0, end: 1.5, text: "hello" }],
    })
    expect(surface.transcribeGated).toHaveBeenCalledWith(expect.objectContaining({ audio: "AAAA" }))
  })
})
