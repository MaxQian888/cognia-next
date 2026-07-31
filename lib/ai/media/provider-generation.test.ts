import { experimental_generateVideo, generateImage } from "ai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
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
  generateProviderImage,
  generateProviderVideo,
} from "./provider-generation"

jest.mock("ai", () => ({
  generateImage: jest.fn(),
  experimental_generateVideo: jest.fn(),
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
  createGoogleGenerativeAI: jest.fn(() => ({
    image: jest.fn(() => "google-image-model"),
    video: jest.fn(() => "google-video-model"),
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
const generatedVideo = {
  video: { uint8Array: new Uint8Array([2]), base64: "Ag==", mediaType: "video/mp4" },
  videos: [],
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
    ;(experimental_generateVideo as jest.Mock).mockResolvedValue(generatedVideo)
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
    ["google", createGoogleGenerativeAI, "gemini-3.1-flash-image-preview"],
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

  it("uses Google Veo for video generation", async () => {
    const settings = snapshot("google", {
      google: {
        enabled: true,
        apiKey: "google-key",
        defaultModel: "gemini-3-pro",
      },
    })

    await expect(
      generateProviderVideo({
        snapshot: settings,
        prompt: "A paper boat crossing a puddle",
        aspectRatio: "16:9",
      })
    ).resolves.toBe(generatedVideo)

    const googleClient = (createGoogleGenerativeAI as jest.Mock).mock.results[0].value
    expect(googleClient.video).toHaveBeenCalledWith("veo-3.1-generate-preview")
    expect(experimental_generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "google-video-model",
        prompt: "A paper boat crossing a puddle",
        aspectRatio: "16:9",
      })
    )
  })

  it("passes image and video generation controls through to the AI SDK", async () => {
    const settings = snapshot("xai", {
      xai: {
        enabled: true,
        apiKey: "xai-key",
        defaultModel: "grok-4",
      },
    })
    const imageController = new AbortController()
    const videoController = new AbortController()

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
    await generateProviderVideo({
      snapshot: settings,
      prompt: "A clockwork bird takes flight",
      n: 2,
      aspectRatio: "16:9",
      resolution: "1280x720",
      duration: 8,
      fps: 24,
      seed: 7,
      providerOptions: { xai: { resolution: "720p" } },
      abortSignal: videoController.signal,
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
    expect(experimental_generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "xai-video-model",
        n: 2,
        aspectRatio: "16:9",
        resolution: "1280x720",
        duration: 8,
        fps: 24,
        seed: 7,
        providerOptions: { xai: { resolution: "720p" } },
        abortSignal: videoController.signal,
      })
    )
  })

  it("constructs FAL and Replicate with their provider-specific credential names", async () => {
    const falSettings = snapshot("fal", {
      fal: { enabled: true, apiKey: "fal-key", defaultModel: "unused-chat-model" },
    })
    const replicateSettings = snapshot("replicate", {
      replicate: { enabled: true, apiKey: "replicate-token", defaultModel: "unused-chat-model" },
    })

    await generateProviderVideo({ snapshot: falSettings, prompt: "A quiet forest" })
    await generateProviderVideo({ snapshot: replicateSettings, prompt: "A bright city" })

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
      await generateProviderVideo({ snapshot: settings, prompt: "A clay robot waves" })

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

    await generateProviderVideo({ snapshot: settings, prompt: "Clouds cross a mountain ridge" })

    expect(createAlibaba).toHaveBeenCalledWith({
      apiKey: "dashscope-key",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      videoBaseURL: "https://dashscope.aliyuncs.com",
    })
    const client = (createAlibaba as jest.Mock).mock.results[0].value
    expect(client.video).toHaveBeenCalledWith("wan2.7-t2v")
    expect(experimental_generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({ model: "alibaba-video-model" })
    )
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
    await expect(
      generateProviderVideo({
        snapshot: settings,
        prompt: {
          text: "Contact bob@example.com",
          image: "data:image/png;base64,AQ==",
        },
      })
    ).rejects.toMatchObject({ code: "PII_BLOCKED" })
  })

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

    await expect(
      generateProviderVideo({
        snapshot: snapshot("openai", {
          openai: { enabled: true, apiKey: "openai-key" },
        }),
        prompt: "A paper sculpture spins",
        providerId: "openai" as never,
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER", providerId: "openai" })

    await expect(
      generateProviderVideo({
        snapshot: snapshot("google", {}),
        prompt: "A paper sculpture spins",
      })
    ).rejects.toMatchObject({ code: "NO_PROVIDER" })
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
