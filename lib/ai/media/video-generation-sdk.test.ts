import {
  BROWSER_DIRECT_VIDEO_PROVIDERS,
  VIDEO_PROVIDER_OPTIONS,
  VIDEO_PROVIDERS,
  videoStartFrameMode,
  isSupportedVideoProvider,
  resolveVideoModel,
  type VideoProviderId,
} from "./video-generation-sdk"

describe("video-generation-sdk registry", () => {
  const providerIds = Object.keys(VIDEO_PROVIDERS) as VideoProviderId[]

  it("keeps every default model in its provider model list", () => {
    for (const providerId of providerIds) {
      const definition = VIDEO_PROVIDERS[providerId]
      expect(definition.id).toBe(providerId)
      expect(definition.models).toContain(definition.defaultModel)
    }
  })

  it("covers every configured video-capable provider", () => {
    expect(providerIds).toEqual([
      "google",
      "xai",
      "fal",
      "replicate",
      "doubao",
      "volcengine",
      "qwen",
    ])
  })

  it("recognizes supported providers", () => {
    expect(isSupportedVideoProvider("google")).toBe(true)
    expect(isSupportedVideoProvider("replicate")).toBe(true)
    expect(isSupportedVideoProvider("doubao")).toBe(true)
    expect(isSupportedVideoProvider("openai")).toBe(false)
  })

  it("keeps a configured video model and otherwise uses the provider default", () => {
    expect(resolveVideoModel("google", "veo-3.1-fast-generate-preview")).toBe(
      "veo-3.1-fast-generate-preview"
    )
    expect(resolveVideoModel("google", "gemini-3-pro")).toBe(VIDEO_PROVIDERS.google.defaultModel)
    expect(resolveVideoModel("xai")).toBe(VIDEO_PROVIDERS.xai.defaultModel)
    expect(resolveVideoModel("volcengine")).toBe(VIDEO_PROVIDERS.volcengine.defaultModel)
    expect(resolveVideoModel("qwen")).toBe("wan2.7-t2v")
  })

  it("declares option support for every provider", () => {
    expect(Object.keys(VIDEO_PROVIDER_OPTIONS).sort()).toEqual([...providerIds].sort())
    expect(VIDEO_PROVIDER_OPTIONS.qwen.aspectRatio).toBe(false)
    expect(VIDEO_PROVIDER_OPTIONS.xai.seed).toBe(false)
    expect(VIDEO_PROVIDER_OPTIONS.fal.resolution).toBe(false)
  })

  it("reads the start-frame mode from the model id", () => {
    expect(videoStartFrameMode("wan2.6-i2v-flash")).toBe("required")
    expect(videoStartFrameMode("wan2.7-t2v")).toBe("unsupported")
    expect(videoStartFrameMode("wan2.7-r2v")).toBe("unsupported")
    expect(videoStartFrameMode("veo-3.1-generate-preview")).toBe("optional")
    for (const providerId of providerIds) {
      for (const model of VIDEO_PROVIDERS[providerId].models) {
        expect(["optional", "required", "unsupported"]).toContain(videoStartFrameMode(model))
      }
    }
  })

  it("only lists browser-direct providers that are video providers", () => {
    // Pinned: widening this set is a claim about a vendor's CORS policy.
    expect([...BROWSER_DIRECT_VIDEO_PROVIDERS]).toEqual(["google"])
  })
})
