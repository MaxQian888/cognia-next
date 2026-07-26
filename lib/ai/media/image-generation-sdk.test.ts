import {
  DEFAULT_IMAGE_MODELS,
  IMAGE_EDIT_PROVIDER_IDS,
  IMAGE_PROVIDERS,
  isImageCapableModel,
  isImageEditProvider,
  isSupportedImageProvider,
  providerSupportsMaskEdit,
  resolveDefaultImageModel,
  resolveImageModel,
  type ImageProviderId,
} from "./image-generation-sdk"

describe("image-generation-sdk registry", () => {
  const providerIds = Object.keys(IMAGE_PROVIDERS) as ImageProviderId[]

  describe("IMAGE_PROVIDERS invariants", () => {
    it.each(providerIds)("%s default model is listed and image-capable", (id) => {
      const def = IMAGE_PROVIDERS[id]
      expect(def.id).toBe(id)
      expect(def.models).toContain(def.defaultModel)
      expect(def.models.length).toBeGreaterThan(0)
      expect(isImageCapableModel(id, def.defaultModel)).toBe(true)
    })

    it("only allows mask edit on providers that allow edit", () => {
      for (const def of Object.values(IMAGE_PROVIDERS)) {
        if (def.supportsMaskEdit) {
          expect(def.supportsImageEdit).toBe(true)
        }
      }
    })

    it("ships the latest flagship defaults for refreshed providers", () => {
      expect(IMAGE_PROVIDERS.openai.defaultModel).toBe("gpt-image-2")
      expect(IMAGE_PROVIDERS.xai.defaultModel).toBe("grok-imagine-image-quality")
      expect(IMAGE_PROVIDERS.togetherai.defaultModel).toBe("black-forest-labs/FLUX.2-dev")
      expect(IMAGE_PROVIDERS.deepinfra.defaultModel).toBe("black-forest-labs/FLUX-2-klein-9b")
      expect(IMAGE_PROVIDERS.google.defaultModel).toBe("gemini-3.1-flash-image-preview")
      expect(IMAGE_PROVIDERS.doubao.defaultModel).toBe("seedream-5-0-260128")
    })
  })

  describe("DEFAULT_IMAGE_MODELS", () => {
    it("mirrors each provider's default model", () => {
      for (const def of Object.values(IMAGE_PROVIDERS)) {
        expect(DEFAULT_IMAGE_MODELS[def.id]).toBe(def.defaultModel)
      }
    })

    it("keeps the legacy `together` alias pointing at the togetherai default", () => {
      expect(DEFAULT_IMAGE_MODELS.together).toBe(DEFAULT_IMAGE_MODELS.togetherai)
    })
  })

  describe("IMAGE_EDIT_PROVIDER_IDS", () => {
    it("contains only edit-capable providers and excludes the together alias", () => {
      for (const id of IMAGE_EDIT_PROVIDER_IDS) {
        expect(IMAGE_PROVIDERS[id].supportsImageEdit).toBe(true)
      }
      expect(IMAGE_EDIT_PROVIDER_IDS).not.toContain("together")
      expect(IMAGE_EDIT_PROVIDER_IDS).not.toContain("google")
    })

    it("excludes providers that only do text-to-image", () => {
      const textToImageOnly = Object.values(IMAGE_PROVIDERS).filter((d) => !d.supportsImageEdit)
      for (const def of textToImageOnly) {
        expect(IMAGE_EDIT_PROVIDER_IDS).not.toContain(def.id)
      }
      expect(textToImageOnly.map((d) => d.id)).toEqual(
        expect.arrayContaining(["google", "fal", "replicate", "nvidia"])
      )
    })
  })

  describe("isSupportedImageProvider", () => {
    it("recognizes registry providers and rejects strangers", () => {
      expect(isSupportedImageProvider("openai")).toBe(true)
      expect(isSupportedImageProvider("together")).toBe(true)
      expect(isSupportedImageProvider("nvidia")).toBe(true)
      expect(isSupportedImageProvider("anthropic")).toBe(false)
      expect(isSupportedImageProvider("")).toBe(false)
    })
  })

  describe("isImageEditProvider", () => {
    it("only accepts the OpenAI-edit-compatible subset", () => {
      expect(isImageEditProvider("openai")).toBe(true)
      expect(isImageEditProvider("deepinfra")).toBe(true)
      expect(isImageEditProvider("google")).toBe(false)
      expect(isImageEditProvider("together")).toBe(false)
      expect(isImageEditProvider("unknown")).toBe(false)
    })
  })

  describe("resolveDefaultImageModel", () => {
    it("returns the default for known providers and undefined otherwise", () => {
      expect(resolveDefaultImageModel("xai")).toBe("grok-imagine-image-quality")
      expect(resolveDefaultImageModel("anthropic")).toBeUndefined()
    })
  })

  describe("isImageCapableModel", () => {
    it("matches each provider's known model families", () => {
      expect(isImageCapableModel("openai", "gpt-image-1.5")).toBe(true)
      expect(isImageCapableModel("openai", "dall-e-3")).toBe(true)
      expect(isImageCapableModel("xai", "grok-imagine-image")).toBe(true)
      expect(isImageCapableModel("xai", "grok-2-image")).toBe(true)
      expect(isImageCapableModel("togetherai", "black-forest-labs/FLUX.2-dev")).toBe(true)
      expect(isImageCapableModel("fireworks", "accounts/fireworks/models/flux-1-dev-fp8")).toBe(
        true
      )
      expect(isImageCapableModel("deepinfra", "ByteDance/Seedream-4.5")).toBe(true)
      expect(isImageCapableModel("google", "imagen-4.0-ultra-generate-001")).toBe(true)
      expect(isImageCapableModel("fal", "fal-ai/qwen-image")).toBe(true)
      expect(isImageCapableModel("deepinfra", "Qwen/Qwen-Image-Max")).toBe(true)
      expect(isImageCapableModel("nvidia", "qwen/qwen-image")).toBe(true)
      expect(isImageCapableModel("replicate", "ideogram-ai/ideogram-v2")).toBe(true)
    })

    it("is case-insensitive", () => {
      expect(isImageCapableModel("openai", "GPT-IMAGE-1")).toBe(true)
    })

    it("rejects non-image models, empty, and unknown providers", () => {
      expect(isImageCapableModel("openai", "gpt-4o")).toBe(false)
      expect(isImageCapableModel("openai", undefined)).toBe(false)
      expect(isImageCapableModel("openai", "")).toBe(false)
      expect(isImageCapableModel("anthropic", "claude-3-image")).toBe(false)
    })
  })

  describe("resolveImageModel", () => {
    it("passes through a configured image-capable model", () => {
      expect(resolveImageModel("xai", "grok-2-image")).toBe("grok-2-image")
    })

    it("falls back to the default for a non-image or missing model", () => {
      expect(resolveImageModel("openai", "gpt-4o")).toBe("gpt-image-2")
      expect(resolveImageModel("openai")).toBe("gpt-image-2")
    })
  })

  describe("providerSupportsMaskEdit", () => {
    it("reflects the per-provider mask capability", () => {
      expect(providerSupportsMaskEdit("openai")).toBe(true)
      expect(providerSupportsMaskEdit("xai")).toBe(false)
      expect(providerSupportsMaskEdit("anthropic")).toBe(false)
    })
  })
})
