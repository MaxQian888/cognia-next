import { generateImage } from "ai"
import { createGoogle } from "@ai-sdk/google"
import { createXai } from "@ai-sdk/xai"
import { createFal } from "@ai-sdk/fal"
import { createReplicate } from "@ai-sdk/replicate"
import { createByteDance } from "@ai-sdk/bytedance"
import { createOpenAI } from "@ai-sdk/openai"
import { createAzure } from "@ai-sdk/azure"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createFireworks } from "@ai-sdk/fireworks"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createAlibaba } from "@ai-sdk/alibaba"

import type { ProviderSettingsSnapshot } from "@/lib/ai/provider-consumption"
import {
  MediaGenerationError,
  assertSafeMediaPrompt,
  createProviderVideoModel,
  generateProviderImage,
  resolveVideoProvider,
} from "./provider-generation"

jest.mock("ai", () => ({
  generateImage: jest.fn(),
}))

jest.mock("@ai-sdk/openai", () => ({
  createOpenAI: jest.fn(() => ({ image: jest.fn(() => "openai-image-model") })),
}))
jest.mock("@ai-sdk/azure", () => ({
  createAzure: jest.fn(() => ({ image: jest.fn(() => "azure-image-model") })),
}))
jest.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: jest.fn(() => ({ image: jest.fn(() => "bedrock-image-model") })),
}))
jest.mock("@ai-sdk/google", () => ({
  createGoogle: jest.fn(() => ({
    image: jest.fn(() => "google-image-model"),
    video: jest.fn(() => "google-video-model"),
    interactions: jest.fn(() => ({ doGenerate: jest.fn() })),
  })),
}))
jest.mock("@ai-sdk/xai", () => ({
  createXai: jest.fn(() => ({
    image: jest.fn(() => "xai-image-model"),
    video: jest.fn(() => "xai-video-model"),
  })),
}))
jest.mock("@ai-sdk/togetherai", () => ({
  createTogetherAI: jest.fn(() => ({ image: jest.fn(() => "together-image-model") })),
}))
jest.mock("@ai-sdk/fireworks", () => ({
  createFireworks: jest.fn(() => ({ image: jest.fn(() => "fireworks-image-model") })),
}))
jest.mock("@ai-sdk/deepinfra", () => ({
  createDeepInfra: jest.fn(() => ({ image: jest.fn(() => "deepinfra-image-model") })),
}))
jest.mock("@ai-sdk/fal", () => ({
  createFal: jest.fn(() => ({
    image: jest.fn(() => "fal-image-model"),
    video: jest.fn(() => "fal-video-model"),
  })),
}))
jest.mock("@ai-sdk/replicate", () => ({
  createReplicate: jest.fn(() => ({
    image: jest.fn(() => "replicate-image-model"),
    video: jest.fn(() => "replicate-video-model"),
  })),
}))
jest.mock("@ai-sdk/bytedance", () => ({
  createByteDance: jest.fn(() => ({
    image: jest.fn(() => "bytedance-image-model"),
    video: jest.fn(() => "bytedance-video-model"),
  })),
}))
jest.mock("@ai-sdk/alibaba", () => ({
  createAlibaba: jest.fn(() => ({
    video: jest.fn(() => "alibaba-video-model"),
  })),
}))

const generatedImage = {
  image: { uint8Array: new Uint8Array([1]), base64: "AQ==", mediaType: "image/png" },
  images: [],
}

/** Resolve + build the video model the way a video job does. */
function videoModel(settings: ProviderSettingsSnapshot, providerId?: string, model?: string) {
  return createProviderVideoModel(resolveVideoProvider(settings, providerId), model)
}

function snapshot(
  defaultProvider: string,
  providers: ProviderSettingsSnapshot["providers"]
): ProviderSettingsSnapshot {
  return {
    defaultProvider,
    providers,
    customProviders: [],
  }
}

describe("provider media generation", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(generateImage as jest.Mock).mockResolvedValue(generatedImage)
  })

  it("uses the xAI image adapter and replaces a chat default with the image default", async () => {
    const settings = snapshot("xai", {
      xai: {
        enabled: true,
        apiKey: "xai-key",
        defaultModel: "grok-4",
      },
    })

    await expect(
      generateProviderImage({ snapshot: settings, prompt: "A glass fox", providerId: "xai" })
    ).resolves.toBe(generatedImage)

    const xaiClient = (createXai as jest.Mock).mock.results[0].value
    expect(createXai).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "xai-key",
        baseURL: "https://api.x.ai/v1",
      })
    )
    expect(xaiClient.image).toHaveBeenCalledWith("grok-imagine-image-quality")
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "xai-image-model",
        prompt: "A glass fox",
      })
    )
  })

  it.each([
    ["openai", createOpenAI, "gpt-image-2"],
    ["azure", createAzure, "gpt-image-1"],
    ["bedrock", createAmazonBedrock, "amazon.nova-canvas-v1:0"],
    ["togetherai", createTogetherAI, "black-forest-labs/FLUX.2-dev"],
    ["fireworks", createFireworks, "accounts/fireworks/models/flux-1-schnell-fp8"],
    ["deepinfra", createDeepInfra, "black-forest-labs/FLUX-2-klein-9b"],
  ] as const)(
    "constructs the %s image model with its native AI SDK provider",
    async (providerId, factory, expectedModel) => {
      const settings = snapshot(providerId, {
        [providerId]: {
          enabled: true,
          apiKey: `${providerId}-key`,
          baseURL:
            providerId === "azure" ? "https://example.openai.azure.com/openai/v1" : undefined,
          ...(providerId === "azure" ? { apiProtocol: "azure" as const } : {}),
          defaultModel: "chat-model",
        },
      })

      await generateProviderImage({ snapshot: settings, prompt: "A copper telescope" })

      const client = (factory as jest.Mock).mock.results[0].value
      expect(client.image).toHaveBeenCalledWith(expectedModel)
      expect(generateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          model: `${providerId === "togetherai" ? "together" : providerId}-image-model`,
        })
      )
    }
  )

  it("uses a custom NVIDIA Visual GenAI NIM endpoint", async () => {
    const settings = snapshot("nvidia", {
      nvidia: {
        enabled: true,
        apiKey: "nvapi-key",
        baseURL: "http://localhost:8000/v1",
        defaultModel: "nvidia/nemotron",
      },
    })

    await generateProviderImage({
      snapshot: settings,
      prompt: "A green circuit board",
      model: "black-forest-labs/flux.1-dev",
    })

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: "nvapi-key",
      baseURL: "http://localhost:8000/v1",
    })
    const client = (createOpenAI as jest.Mock).mock.results[0].value
    expect(client.image).toHaveBeenCalledWith("black-forest-labs/flux.1-dev")
  })

  it.each([
    ["fal", createFal, "fal-ai/flux-2-pro", "fal-image-model"],
    ["replicate", createReplicate, "black-forest-labs/flux-2-pro", "replicate-image-model"],
  ] as const)(
    "uses the native %s image adapter",
    async (providerId, factory, expectedModel, expectedHandle) => {
      const settings = snapshot(providerId, {
        [providerId]: {
          enabled: true,
          apiKey: `${providerId}-key`,
          defaultModel: "chat-model",
        },
      })

      await generateProviderImage({ snapshot: settings, prompt: "A moss-covered doorway" })

      const client = (factory as jest.Mock).mock.results[0].value
      expect(client.image).toHaveBeenCalledWith(expectedModel)
      expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({ model: expectedHandle }))
    }
  )

  it("keeps explicitly selected Google Veo on its native adapter", () => {
    const settings = snapshot("google", {
      google: {
        enabled: true,
        apiKey: "google-key",
        defaultModel: "gemini-3-pro",
      },
    })

    expect(videoModel(settings, undefined, "veo-3.1-generate-preview")).toBe("google-video-model")

    const googleClient = (createGoogle as jest.Mock).mock.results[0].value
    expect(googleClient.video).toHaveBeenCalledWith("veo-3.1-generate-preview")
  })

  it("threads an injected fetch into every video provider client", () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch
    const configs: Array<[string, ProviderSettingsSnapshot["providers"][string]]> = [
      ["xai", { enabled: true, apiKey: "k" }],
      ["fal", { enabled: true, apiKey: "k" }],
      ["replicate", { enabled: true, apiKey: "k" }],
      ["doubao", { enabled: true, apiKey: "k", baseURL: "https://ark.test/api/v3" }],
      [
        "qwen",
        { enabled: true, apiKey: "k", baseURL: "https://dashscope.test/compatible-mode/v1" },
      ],
    ]
    for (const [providerId, config] of configs) {
      const settings = snapshot(providerId, { [providerId]: config })
      createProviderVideoModel(resolveVideoProvider(settings), undefined, { fetch: fetchImpl })
    }
    for (const factory of [createXai, createFal, createReplicate, createByteDance, createAlibaba]) {
      expect(factory).toHaveBeenCalledWith(expect.objectContaining({ fetch: fetchImpl }))
    }
  })

  it("passes image generation controls through to the AI SDK", async () => {
    const settings = snapshot("xai", {
      xai: {
        enabled: true,
        apiKey: "xai-key",
        defaultModel: "grok-4",
      },
    })
    const imageController = new AbortController()

    await generateProviderImage({
      snapshot: settings,
      prompt: "A clockwork bird",
      n: 2,
      size: "1024x1024",
      aspectRatio: "1:1",
      seed: 42,
      providerOptions: { xai: { quality: "high" } },
      abortSignal: imageController.signal,
    })

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        n: 2,
        size: "1024x1024",
        aspectRatio: "1:1",
        seed: 42,
        providerOptions: { xai: { quality: "high" } },
        abortSignal: imageController.signal,
      })
    )
    expect(videoModel(settings, undefined, "grok-imagine-video")).toBe("xai-video-model")
  })

  it("constructs FAL and Replicate with their provider-specific credential names", async () => {
    const falSettings = snapshot("fal", {
      fal: { enabled: true, apiKey: "fal-key", defaultModel: "unused-chat-model" },
    })
    const replicateSettings = snapshot("replicate", {
      replicate: { enabled: true, apiKey: "replicate-token", defaultModel: "unused-chat-model" },
    })

    videoModel(falSettings)
    videoModel(replicateSettings)

    expect(createFal).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "fal-key", baseURL: "https://fal.run" })
    )
    expect(createReplicate).toHaveBeenCalledWith(
      expect.objectContaining({
        apiToken: "replicate-token",
        baseURL: "https://api.replicate.com/v1",
      })
    )
  })

  it.each(["doubao", "volcengine"] as const)(
    "uses the native ByteDance adapter for %s Seedream and Seedance models",
    async (providerId) => {
      const settings = snapshot(providerId, {
        [providerId]: {
          enabled: true,
          apiKey: "ark-key",
          baseURL: "https://ark.cn-beijing.volces.com/api/v3",
          defaultModel: "doubao-seed-2-0-pro",
        },
      })

      await generateProviderImage({ snapshot: settings, prompt: "A clay robot" })
      videoModel(settings)

      expect(createByteDance).toHaveBeenCalledWith({
        apiKey: "ark-key",
        baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      })
      const imageClient = (createByteDance as jest.Mock).mock.results[0].value
      const videoClient = (createByteDance as jest.Mock).mock.results[1].value
      expect(imageClient.image).toHaveBeenCalledWith("seedream-5-0-260128")
      expect(videoClient.video).toHaveBeenCalledWith("dreamina-seedance-2-0-260128")
    }
  )

  it("uses the native Alibaba adapter and DashScope video endpoint for Qwen Wan", async () => {
    const settings = snapshot("qwen", {
      qwen: {
        enabled: true,
        apiKey: "dashscope-key",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        defaultModel: "qwen-max",
      },
    })

    expect(videoModel(settings)).toBe("alibaba-video-model")

    expect(createAlibaba).toHaveBeenCalledWith({
      apiKey: "dashscope-key",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      videoBaseURL: "https://dashscope.aliyuncs.com",
    })
    const client = (createAlibaba as jest.Mock).mock.results[0].value
    expect(client.video).toHaveBeenCalledWith("wan2.7-t2v")
  })

  it("blocks prompts that fail the outbound PII gate", async () => {
    const settings = snapshot("xai", {
      xai: { enabled: true, apiKey: "xai-key", defaultModel: "grok-4" },
    })

    await expect(
      generateProviderImage({
        snapshot: settings,
        prompt: "Email me at alice@example.com",
      })
    ).rejects.toBeInstanceOf(MediaGenerationError)
    expect(generateImage).not.toHaveBeenCalled()
  })

  it("blocks PII in structured image and video prompts", async () => {
    const settings = snapshot("xai", {
      xai: { enabled: true, apiKey: "xai-key", defaultModel: "grok-4" },
    })

    await expect(
      generateProviderImage({
        snapshot: settings,
        prompt: { text: "Contact alice@example.com", images: ["data:image/png;base64,AQ=="] },
      })
    ).rejects.toMatchObject({ code: "PII_BLOCKED" })
    expect(() =>
      assertSafeMediaPrompt({
        text: "Contact bob@example.com",
        image: "data:image/png;base64,AQ==",
      })
    ).toThrow(expect.objectContaining({ code: "PII_BLOCKED" }))
    expect(() => assertSafeMediaPrompt("A paper boat")).not.toThrow()
  })

  it.each([
    { systemInstruction: "Contact alice@example.com" },
    { responseFormat: [{ type: "image", description: "Contact alice@example.com" }] },
    { "alice@example.com": "clean value" },
  ])(
    "blocks PII in Google image provider options before constructing a client: %j",
    async (google) => {
      await expect(
        generateProviderImage({
          snapshot: snapshot("google", { google: { enabled: true, apiKey: "google-key" } }),
          prompt: "A glass fox",
          providerOptions: { google },
        })
      ).rejects.toMatchObject({ code: "PII_BLOCKED" })
      expect(createGoogle).not.toHaveBeenCalled()
      expect(generateImage).not.toHaveBeenCalled()
    }
  )

  it("rejects unsupported explicit providers and missing configurations", async () => {
    await expect(
      generateProviderImage({
        snapshot: snapshot("anthropic", {
          anthropic: { enabled: true, apiKey: "anthropic-key" },
        }),
        prompt: "A paper sculpture",
        providerId: "anthropic" as never,
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER", providerId: "anthropic" })

    expect(() =>
      resolveVideoProvider(
        snapshot("openai", { openai: { enabled: true, apiKey: "openai-key" } }),
        "openai"
      )
    ).toThrow(expect.objectContaining({ code: "UNSUPPORTED_PROVIDER", providerId: "openai" }))

    expect(() => resolveVideoProvider(snapshot("google", {}))).toThrow(
      expect.objectContaining({ code: "NO_PROVIDER" })
    )
  })

  it("falls back from a non-media default to a configured media provider", async () => {
    const settings = snapshot("anthropic", {
      anthropic: { enabled: true, apiKey: "anthropic-key" },
      openai: { enabled: true, apiKey: "openai-key", defaultModel: "gpt-4o" },
    })

    await generateProviderImage({ snapshot: settings, prompt: "A folded paper moon" })

    expect(createOpenAI).toHaveBeenCalled()
    expect(generateImage).toHaveBeenCalled()
  })

  it("requires an explicit Visual GenAI NIM endpoint for NVIDIA images", async () => {
    const settings = snapshot("nvidia", {
      nvidia: { enabled: true, apiKey: "nvapi-key", defaultModel: "meta/llama" },
    })

    await expect(
      generateProviderImage({ snapshot: settings, prompt: "A green circuit board" })
    ).rejects.toMatchObject({
      code: "PROVIDER_CONFIGURATION",
      providerId: "nvidia",
    })
    expect(generateImage).not.toHaveBeenCalled()
  })
})

describe("Google Interactions media request contracts", () => {
  const settings = () =>
    snapshot("google", {
      google: { enabled: true, apiKey: "google-key", defaultModel: "gemini-3.8-flash" },
    })
  const videoOptions = {
    prompt: "A kite rises",
    n: 1,
    aspectRatio: "9:16" as const,
    resolution: "1920x1080" as const,
    duration: 8,
    fps: undefined,
    seed: undefined,
    image: undefined,
    frameImages: undefined,
    inputReferences: undefined,
    generateAudio: undefined,
    providerOptions: {},
  }
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

  it("routes Nano Banana through installed SDK Interactions with an explicit image format", async () => {
    jest.clearAllMocks()
    const transport = jest.fn().mockResolvedValue(
      json({
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "image", mime_type: "image/png", data: "AQ==" }],
          },
        ],
      })
    )
    const actual = jest.requireActual("@ai-sdk/google") as typeof import("@ai-sdk/google")
    ;(createGoogle as jest.Mock).mockImplementationOnce((config) =>
      actual.createGoogle({ ...config, fetch: transport })
    )
    ;(generateImage as jest.Mock).mockImplementationOnce(async ({ model, prompt, aspectRatio }) =>
      model.doGenerate({
        prompt,
        aspectRatio,
        n: 1,
        size: undefined,
        seed: undefined,
        files: undefined,
        mask: undefined,
        providerOptions: {},
      })
    )
    const result = await generateProviderImage({
      snapshot: settings(),
      prompt: "A glass fox",
      aspectRatio: "16:9",
    })
    expect(result.images).toEqual(["AQ=="])
    expect(transport.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions"
    )
    expect(JSON.parse(transport.mock.calls[0][1].body)).toMatchObject({
      model: "gemini-nano-banana-2.1",
      store: false,
      background: false,
      response_format: [{ type: "image", mime_type: "image/png", aspect_ratio: "16:9" }],
    })
  })

  it("starts a restartable Omni interaction and polls inline video results", async () => {
    const controller = new AbortController()
    const transport = jest
      .fn()
      .mockResolvedValueOnce(json({ id: "v1_resume", status: "in_progress" }))
      .mockResolvedValueOnce(json({ id: "v1_resume", status: "in_progress" }))
      .mockResolvedValueOnce(
        json({
          id: "v1_resume",
          status: "completed",
          steps: [
            {
              type: "model_output",
              content: [{ type: "video", mime_type: "video/mp4", data: "AQ==" }],
            },
          ],
        })
      )
    const model = createProviderVideoModel(resolveVideoProvider(settings()), undefined, {
      fetch: transport,
    })
    const started = await model.doStart!({
      ...videoOptions,
      image: { type: "file", data: new Uint8Array([1]), mediaType: "image/png" },
      abortSignal: controller.signal,
    })
    expect(started.operation).toEqual({ interactionId: "v1_resume" })
    const [url, init] = transport.mock.calls[0]
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions")
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("google-key")
    expect(JSON.parse(init.body)).toMatchObject({
      model: "gemini-omni-1.1-flash",
      background: true,
      store: true,
      input: [
        { type: "image", data: "AQ==", mime_type: "image/png" },
        { type: "text", text: "<FIRST_FRAME> A kite rises" },
      ],
      response_format: { type: "video", aspect_ratio: "9:16", resolution: "1080p", duration: "8s" },
    })
    const resumed = createProviderVideoModel(
      resolveVideoProvider(settings()),
      "gemini-omni-1.1-flash",
      { fetch: transport }
    )
    expect(
      await resumed.doStatus!({ operation: JSON.parse(JSON.stringify(started.operation)) })
    ).toMatchObject({ status: "pending" })
    expect(await resumed.doStatus!({ operation: started.operation })).toMatchObject({
      status: "completed",
      videos: [{ type: "base64", mediaType: "video/mp4", data: "AQ==" }],
    })
    expect(transport.mock.calls[1][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions/v1_resume"
    )
  })

  it("reports failed and empty Omni results without silently succeeding", async () => {
    const transport = jest
      .fn()
      .mockResolvedValueOnce(json({ status: "failed", error: { message: "quota" } }))
      .mockResolvedValueOnce(json({ status: "completed", steps: [] }))
    const model = createProviderVideoModel(resolveVideoProvider(settings()), undefined, {
      fetch: transport,
    })
    expect(await model.doStatus!({ operation: { interactionId: "v1" } })).toMatchObject({
      status: "error",
      error: "quota",
    })
    expect(await model.doStatus!({ operation: { interactionId: "v1" } })).toMatchObject({
      status: "error",
      error: expect.stringContaining("no video"),
    })
  })

  it("refuses unsupported controls and PII before sending the Omni payload", async () => {
    const transport = jest.fn()
    const model = createProviderVideoModel(resolveVideoProvider(settings()), undefined, {
      fetch: transport,
    })
    await expect(model.doStart!({ ...videoOptions, seed: 0 })).rejects.toThrow(/seed/)
    await expect(
      model.doStart!({ ...videoOptions, providerOptions: { google: { negativePrompt: "blur" } } })
    ).rejects.toThrow(/Veo provider options/)
    await expect(
      model.doStart!({ ...videoOptions, prompt: "Email alice@example.com" })
    ).rejects.toMatchObject({ code: "PII_BLOCKED" })
    expect(transport).not.toHaveBeenCalled()
  })

  it("preserves cancellation and transport failures", async () => {
    const controller = new AbortController()
    controller.abort()
    const transport = jest.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"))
    const model = createProviderVideoModel(resolveVideoProvider(settings()), undefined, {
      fetch: transport,
    })
    await expect(
      model.doStart!({ ...videoOptions, abortSignal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true)
    const failed = createProviderVideoModel(resolveVideoProvider(settings()), undefined, {
      fetch: jest.fn().mockResolvedValue(json({}, 429)),
    })
    await expect(failed.doStart!(videoOptions)).rejects.toThrow(/HTTP 429/)
  })
})

it("retains a retired image pin but refuses new inference instead of rewriting it", async () => {
  jest.clearAllMocks()
  const settings = snapshot("google", {
    google: { enabled: true, apiKey: "k", defaultModel: "gemini-3.1-flash-image-preview" },
  })
  await expect(
    generateProviderImage({ snapshot: settings, prompt: "A kite" })
  ).rejects.toMatchObject({
    code: "PROVIDER_CONFIGURATION",
    message: expect.stringContaining("retired"),
  })
  expect(settings.providers.google.defaultModel).toBe("gemini-3.1-flash-image-preview")
  expect(generateImage).not.toHaveBeenCalled()
})
