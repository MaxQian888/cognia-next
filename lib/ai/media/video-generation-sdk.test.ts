import {
  VIDEO_PROVIDERS,
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
})
