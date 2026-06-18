import {
  resolveModelsDevProviderId,
  resolveOurProviderId,
  builtInProvidersWithModelsDevEntry,
  MODELS_DEV_PROVIDER_ID_MAP,
} from "./models-dev-id-map"

describe("models-dev-id-map", () => {
  describe("resolveModelsDevProviderId", () => {
    it("maps known differences to the models.dev id", () => {
      expect(resolveModelsDevProviderId("fireworks")).toBe("fireworks-ai")
      expect(resolveModelsDevProviderId("zhipu")).toBe("zhipuai")
      expect(resolveModelsDevProviderId("glm4")).toBe("zhipuai")
      expect(resolveModelsDevProviderId("qwen")).toBe("alibaba")
      expect(resolveModelsDevProviderId("bedrock")).toBe("amazon-bedrock")
      expect(resolveModelsDevProviderId("github")).toBe("github-models")
    })

    it("returns identity for providers that match models.dev verbatim", () => {
      expect(resolveModelsDevProviderId("openai")).toBe("openai")
      expect(resolveModelsDevProviderId("anthropic")).toBe("anthropic")
      expect(resolveModelsDevProviderId("lmstudio")).toBe("lmstudio")
    })

    it("is case-insensitive", () => {
      expect(resolveModelsDevProviderId("Fireworks")).toBe("fireworks-ai")
      expect(resolveModelsDevProviderId("OpenAI")).toBe("openai")
    })

    it("returns undefined for providers models.dev does not track", () => {
      expect(resolveModelsDevProviderId("ollama")).toBeUndefined()
      expect(resolveModelsDevProviderId("sambanova")).toBeUndefined()
      expect(resolveModelsDevProviderId("vllm")).toBeUndefined()
      expect(resolveModelsDevProviderId("totally-unknown")).toBeUndefined()
    })
  })

  describe("resolveOurProviderId", () => {
    it("reverses the difference map", () => {
      expect(resolveOurProviderId("fireworks-ai")).toBe("fireworks")
      expect(resolveOurProviderId("amazon-bedrock")).toBe("bedrock")
    })

    it("reverses identity providers", () => {
      expect(resolveOurProviderId("anthropic")).toBe("anthropic")
    })

    it("returns undefined for unknown models.dev ids", () => {
      expect(resolveOurProviderId("google-vertex")).toBeUndefined()
    })
  })

  describe("builtInProvidersWithModelsDevEntry", () => {
    it("includes mapped and identity providers, excludes untracked ones", () => {
      const list = builtInProvidersWithModelsDevEntry()
      expect(list).toContain("openai")
      expect(list).toContain("fireworks")
      expect(list).toContain("zhipu")
      expect(list).not.toContain("ollama")
      expect(list).not.toContain("sambanova")
    })
  })

  it("difference map never maps to identity (would be redundant)", () => {
    for (const [ourId, devId] of Object.entries(MODELS_DEV_PROVIDER_ID_MAP)) {
      expect(ourId).not.toBe(devId)
    }
  })
})
