/**
 * Tests for provider cache profile utilities
 */

import type { ProviderName } from "@/types/provider"
import {
  getProviderCacheProfile,
  shouldPrioritizePrefixStability,
  isLocalInferenceProvider,
  getProvidersWithPrefixCache,
} from "./provider-cache-profile"

describe("provider-cache-profile", () => {
  describe("getProviderCacheProfile", () => {
    it("should return auto cache profile for OpenAI", () => {
      const profile = getProviderCacheProfile("openai")
      expect(profile.supportsPrefixCache).toBe(true)
      expect(profile.cacheType).toBe("auto")
      expect(profile.cachedTokenDiscount).toBe(0.5)
      expect(profile.requiresCacheControl).toBe(false)
      expect(profile.prefixStabilityImportance).toBe("high")
    })

    it("should return manual cache profile for Anthropic", () => {
      const profile = getProviderCacheProfile("anthropic")
      expect(profile.supportsPrefixCache).toBe(true)
      expect(profile.cacheType).toBe("manual")
      expect(profile.cachedTokenDiscount).toBe(0.9)
      expect(profile.requiresCacheControl).toBe(true)
      expect(profile.prefixStabilityImportance).toBe("high")
    })

    it("should return critical stability for vLLM (local inference)", () => {
      const profile = getProviderCacheProfile("vllm")
      expect(profile.supportsPrefixCache).toBe(true)
      expect(profile.cacheType).toBe("auto")
      expect(profile.cachedTokenDiscount).toBe(1.0)
      expect(profile.prefixStabilityImportance).toBe("critical")
    })

    it("should return critical stability for ollama (local inference)", () => {
      const profile = getProviderCacheProfile("ollama")
      expect(profile.supportsPrefixCache).toBe(true)
      expect(profile.prefixStabilityImportance).toBe("critical")
    })

    it("should return no cache for DeepSeek", () => {
      const profile = getProviderCacheProfile("deepseek")
      expect(profile.supportsPrefixCache).toBe(false)
      expect(profile.cacheType).toBe("none")
      expect(profile.cachedTokenDiscount).toBe(0)
      expect(profile.prefixStabilityImportance).toBe("low")
    })

    it("should return no cache for Groq", () => {
      const profile = getProviderCacheProfile("groq")
      expect(profile.supportsPrefixCache).toBe(false)
      expect(profile.prefixStabilityImportance).toBe("low")
    })

    it("should return default profile for auto provider", () => {
      const profile = getProviderCacheProfile("auto")
      expect(profile.supportsPrefixCache).toBe(false)
      expect(profile.cacheType).toBe("none")
      expect(profile.prefixStabilityImportance).toBe("low")
    })

    it("should return critical stability for all local inference providers", () => {
      const localProviders: ProviderName[] = [
        "vllm",
        "ollama",
        "lmstudio",
        "llamacpp",
        "llamafile",
        "localai",
        "jan",
        "textgenwebui",
        "koboldcpp",
        "tabbyapi",
      ]

      for (const provider of localProviders) {
        const profile = getProviderCacheProfile(provider)
        expect(profile.prefixStabilityImportance).toBe("critical")
        expect(profile.supportsPrefixCache).toBe(true)
        expect(profile.cachedTokenDiscount).toBe(1.0)
      }
    })

    it("should return high stability for Google", () => {
      const profile = getProviderCacheProfile("google")
      expect(profile.supportsPrefixCache).toBe(true)
      expect(profile.cacheType).toBe("auto")
      expect(profile.prefixStabilityImportance).toBe("high")
    })
  })

  describe("shouldPrioritizePrefixStability", () => {
    it("should return true for providers with critical importance", () => {
      expect(shouldPrioritizePrefixStability("vllm")).toBe(true)
      expect(shouldPrioritizePrefixStability("ollama")).toBe(true)
      expect(shouldPrioritizePrefixStability("lmstudio")).toBe(true)
    })

    it("should return true for providers with high importance", () => {
      expect(shouldPrioritizePrefixStability("openai")).toBe(true)
      expect(shouldPrioritizePrefixStability("anthropic")).toBe(true)
      expect(shouldPrioritizePrefixStability("google")).toBe(true)
    })

    it("should return false for providers with low importance", () => {
      expect(shouldPrioritizePrefixStability("deepseek")).toBe(false)
      expect(shouldPrioritizePrefixStability("groq")).toBe(false)
      expect(shouldPrioritizePrefixStability("mistral")).toBe(false)
      expect(shouldPrioritizePrefixStability("auto")).toBe(false)
    })
  })

  describe("isLocalInferenceProvider", () => {
    it("should return true for local providers", () => {
      expect(isLocalInferenceProvider("vllm")).toBe(true)
      expect(isLocalInferenceProvider("ollama")).toBe(true)
      expect(isLocalInferenceProvider("llamacpp")).toBe(true)
    })

    it("should return false for cloud providers", () => {
      expect(isLocalInferenceProvider("openai")).toBe(false)
      expect(isLocalInferenceProvider("anthropic")).toBe(false)
      expect(isLocalInferenceProvider("deepseek")).toBe(false)
    })
  })

  describe("getProvidersWithPrefixCache", () => {
    it("should include OpenAI, Anthropic, Google, and local providers", () => {
      const providers = getProvidersWithPrefixCache()
      expect(providers).toContain("openai")
      expect(providers).toContain("anthropic")
      expect(providers).toContain("google")
      expect(providers).toContain("vllm")
      expect(providers).toContain("ollama")
    })

    it("should not include providers without prefix cache", () => {
      const providers = getProvidersWithPrefixCache()
      expect(providers).not.toContain("deepseek")
      expect(providers).not.toContain("groq")
      expect(providers).not.toContain("mistral")
    })

    it("should return at least 13 providers", () => {
      // 3 cloud (openai, anthropic, google) + 10 local
      const providers = getProvidersWithPrefixCache()
      expect(providers.length).toBeGreaterThanOrEqual(13)
    })
  })
})
