import {
  TWIN_EMBEDDING_REBUILD_REQUIRED,
  buildTwinEmbeddingIndexRecord,
  describeTwinIndexMismatch,
  expectedTwinEmbeddingDimensions,
  isTwinEmbeddingConfigReady,
  normalizeTwinEmbeddingOverride,
  resolveTwinEmbeddingConfig,
  sameEmbeddingModel,
  twinEmbeddingFingerprint,
  twinIndexRebuildRequired,
  twinOverrideModel,
} from "./twin-embedding"
import type { TwinRuntimeEmbeddingSettings } from "@/types/twin"

const GLOBAL: TwinRuntimeEmbeddingSettings = {
  provider: "openai",
  model: "text-embedding-3-small",
  apiKey: "sk-global",
}

describe("resolveTwinEmbeddingConfig", () => {
  it("returns the global config untouched when the twin has no override", () => {
    const result = resolveTwinEmbeddingConfig({ global: GLOBAL })
    expect(result).toEqual({ config: GLOBAL, source: "global", credentialsReady: true })
  })

  it("reports an unready global config the same way the adapter builder does", () => {
    const result = resolveTwinEmbeddingConfig({ global: { ...GLOBAL, apiKey: " " } })
    expect(result.credentialsReady).toBe(false)
  })

  it("reuses the global credentials when the override keeps the global provider", () => {
    const global = { ...GLOBAL, baseURL: "https://proxy.example" }
    const result = resolveTwinEmbeddingConfig({
      override: { provider: "openai", model: "text-embedding-3-large" },
      global,
    })
    expect(result).toEqual({
      config: { ...global, model: "text-embedding-3-large" },
      source: "twin",
      credentialsReady: true,
    })
  })

  it("defaults a blank override model to the catalog default for the provider", () => {
    const result = resolveTwinEmbeddingConfig({
      override: { provider: "openai", model: "  " },
      global: { ...GLOBAL, model: "text-embedding-3-large" },
    })
    expect(result.config.model).toBe("text-embedding-3-small")
  })

  it("resolves another cloud provider's key from the chat-provider settings", () => {
    const result = resolveTwinEmbeddingConfig({
      override: { provider: "cohere" },
      global: GLOBAL,
      providerSettings: { cohere: { apiKey: "co-key", baseURL: "https://chat-proxy" } },
    })
    expect(result).toEqual({
      config: { provider: "cohere", model: "embed-english-v3.0", apiKey: "co-key" },
      source: "twin",
      credentialsReady: true,
    })
  })

  it("marks an override without a key as not ready", () => {
    const result = resolveTwinEmbeddingConfig({
      override: { provider: "mistral" },
      global: GLOBAL,
      providerSettings: {},
    })
    expect(result.config.apiKey).toBe("")
    expect(result.credentialsReady).toBe(false)
  })

  it("takes a local engine's base URL from provider settings, else its default port", () => {
    const configured = resolveTwinEmbeddingConfig({
      override: { provider: "ollama", model: "mxbai-embed-large" },
      global: GLOBAL,
      providerSettings: { ollama: { baseURL: "http://gpu-box:11434" } },
    })
    expect(configured.config).toMatchObject({
      provider: "ollama",
      model: "mxbai-embed-large",
      baseURL: "http://gpu-box:11434",
    })
    expect(configured.credentialsReady).toBe(true)

    const fallback = resolveTwinEmbeddingConfig({
      override: { provider: "ollama" },
      global: GLOBAL,
      providerSettings: {},
    })
    expect(fallback.config.baseURL).toBe("http://localhost:11434")
    expect(fallback.credentialsReady).toBe(true)
  })

  it("needs Bedrock connection settings (or a key) for a Bedrock override", () => {
    const missing = resolveTwinEmbeddingConfig({
      override: { provider: "amazon-bedrock" },
      global: GLOBAL,
      providerSettings: {},
    })
    expect(missing.credentialsReady).toBe(false)

    const bedrock = { authMode: "default-chain" as const, region: "us-east-1" }
    const ready = resolveTwinEmbeddingConfig({
      override: { provider: "amazon-bedrock" },
      global: GLOBAL,
      providerSettings: { bedrock: { bedrock } },
    })
    expect(ready.config.bedrock).toEqual(bedrock)
    expect(ready.credentialsReady).toBe(true)
  })

  it("gives voyage no shared key when the global provider is not voyage", () => {
    const result = resolveTwinEmbeddingConfig({
      override: { provider: "voyage" },
      global: GLOBAL,
      providerSettings: { voyage: { apiKey: "ignored" } },
    })
    expect(result.credentialsReady).toBe(false)
  })
})

describe("fingerprint + index comparison", () => {
  it("formats the fingerprint as provider::model::dimensions", () => {
    expect(
      twinEmbeddingFingerprint({
        provider: "cohere",
        model: "embed-english-v3.0",
        dimensions: 1024,
      })
    ).toBe("cohere::embed-english-v3.0::1024")
    expect(twinEmbeddingFingerprint({ provider: "ollama", model: "m" })).toBe("ollama::m::unknown")
  })

  it("builds an index record carrying its fingerprint", () => {
    expect(
      buildTwinEmbeddingIndexRecord({
        provider: "mistral",
        model: "mistral-embed",
        dimensions: 1024,
        builtAt: 7,
      })
    ).toEqual({
      provider: "mistral",
      model: "mistral-embed",
      dimensions: 1024,
      fingerprint: "mistral::mistral-embed::1024",
      builtAt: 7,
    })
  })

  it("requires a rebuild only when a recorded index names another model", () => {
    const index = buildTwinEmbeddingIndexRecord({
      provider: "cohere",
      model: "embed-english-v3.0",
      dimensions: 1024,
      builtAt: 1,
    })
    // Same dimension (1024), different model — exactly the silent-corruption case.
    expect(twinIndexRebuildRequired({ provider: "mistral", model: "mistral-embed" }, index)).toBe(
      true
    )
    expect(
      twinIndexRebuildRequired({ provider: "cohere", model: "embed-english-v3.0" }, index)
    ).toBe(false)
    // Legacy index (no record) keeps the dimension-guard-only behaviour.
    expect(twinIndexRebuildRequired({ provider: "mistral", model: "x" }, undefined)).toBe(false)
  })

  it("describes a mismatch with the machine-readable rebuild-required prefix", () => {
    const index = buildTwinEmbeddingIndexRecord({
      provider: "cohere",
      model: "embed-english-v3.0",
      dimensions: 1024,
      builtAt: 1,
    })
    const reason = describeTwinIndexMismatch({ provider: "voyage", model: "voyage-3" }, index)
    expect(reason.startsWith(`${TWIN_EMBEDDING_REBUILD_REQUIRED}:`)).toBe(true)
    expect(reason).toContain("cohere::embed-english-v3.0::1024")
    expect(reason).toContain("voyage::voyage-3")
  })

  it("compares provider + model only", () => {
    expect(
      sameEmbeddingModel({ provider: "openai", model: "a" }, { provider: "openai", model: "a" })
    ).toBe(true)
    expect(
      sameEmbeddingModel({ provider: "openai", model: "a" }, { provider: "openai", model: "b" })
    ).toBe(false)
  })
})

describe("helpers", () => {
  it("normalises an override and resolves its model", () => {
    expect(normalizeTwinEmbeddingOverride({ provider: "google", model: " x " })).toEqual({
      provider: "google",
      model: "x",
    })
    expect(normalizeTwinEmbeddingOverride({ provider: "google", model: "" })).toEqual({
      provider: "google",
    })
    expect(twinOverrideModel({ provider: "google" })).toBe("text-embedding-004")
  })

  it("applies the base readiness rule", () => {
    expect(isTwinEmbeddingConfigReady({ provider: "openai", model: "", apiKey: "k" })).toBe(false)
    expect(isTwinEmbeddingConfigReady({ provider: "ollama", model: "m", apiKey: "" })).toBe(false)
    expect(
      isTwinEmbeddingConfigReady({
        provider: "ollama",
        model: "m",
        apiKey: "",
        baseURL: "http://localhost:11434",
      })
    ).toBe(true)
    expect(isTwinEmbeddingConfigReady({ provider: "transformersjs", model: "m", apiKey: "" })).toBe(
      true
    )
  })

  it("reports the catalog dimension for known models", () => {
    expect(
      expectedTwinEmbeddingDimensions({ provider: "cohere", model: "embed-english-v3.0" })
    ).toBe(1024)
  })
})
