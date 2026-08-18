import test from "node:test"
import assert from "node:assert/strict"

import {
  projectEntry,
  buildCatalog,
  serializeCatalog,
  readCommittedCatalog,
  PROVIDER_MAP,
} from "./build-catalog.mjs"

test("projectEntry converts per-token rates to per-1M", () => {
  const out = projectEntry({
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
  })
  assert.equal(out.promptPer1M, 3)
  assert.equal(out.completionPer1M, 15)
})

test("projectEntry carries cache-tier rates when upstream has them", () => {
  const out = projectEntry({
    input_cost_per_token: 0.000005,
    output_cost_per_token: 0.000025,
    cache_read_input_token_cost: 0.0000005,
    cache_creation_input_token_cost: 0.00000625,
  })
  assert.equal(out.cachedInputPer1M, 0.5)
  assert.equal(out.cacheCreationPer1M, 6.25)
})

test("projectEntry drops rows with no base rate", () => {
  // A cache-only row has no anchor; `mergePricingLayers` rejects it anyway, so
  // emitting it would only cost bytes.
  assert.equal(projectEntry({ cache_read_input_token_cost: 0.0000005 }), undefined)
  assert.equal(projectEntry({}), undefined)
  assert.equal(projectEntry(undefined), undefined)
})

test("projectEntry ignores zero and non-finite rates", () => {
  assert.equal(projectEntry({ input_cost_per_token: 0, output_cost_per_token: 0 }), undefined)
  assert.equal(
    projectEntry({ input_cost_per_token: Number.NaN, output_cost_per_token: null }),
    undefined
  )
})

test("projectEntry keeps only the whitelisted fields", () => {
  const out = projectEntry({
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    max_input_tokens: 200000,
    max_output_tokens: 8192,
    litellm_provider: "anthropic",
    mode: "chat",
    supports_vision: true,
  })
  assert.deepEqual(Object.keys(out).sort(), [
    "completionPer1M",
    "maxInputTokens",
    "maxOutputTokens",
    "promptPer1M",
  ])
})

test("buildCatalog keeps only mapped providers", () => {
  const catalog = buildCatalog({
    "gpt-4o": { litellm_provider: "openai", input_cost_per_token: 0.0000025 },
    "some-model": { litellm_provider: "not_a_provider_we_ship", input_cost_per_token: 0.000001 },
  })
  assert.deepEqual(Object.keys(catalog.providers), ["openai"])
  assert.ok(catalog.providers.openai["gpt-4o"])
})

test("buildCatalog skips the upstream sample_spec pseudo-entry", () => {
  const catalog = buildCatalog({
    sample_spec: { litellm_provider: "openai", input_cost_per_token: 0.1 },
  })
  assert.deepEqual(catalog.providers, {})
})

test("buildCatalog strips the provider/ route prefix from model ids", () => {
  const catalog = buildCatalog({
    "vertex_ai/gemini-2.5-pro": { litellm_provider: "vertex_ai", input_cost_per_token: 0.00000125 },
  })
  assert.ok(catalog.providers.google["gemini-2.5-pro"])
})

test("buildCatalog keeps the first entry when a bare id repeats", () => {
  const catalog = buildCatalog({
    "gpt-4o": { litellm_provider: "openai", input_cost_per_token: 0.0000025 },
    "openrouter/gpt-4o": { litellm_provider: "openai", input_cost_per_token: 0.999 },
  })
  assert.equal(catalog.providers.openai["gpt-4o"].promptPer1M, 2.5)
})

test("buildCatalog sorts providers and models for byte-stable regeneration", () => {
  const catalog = buildCatalog({
    zzz: { litellm_provider: "openai", input_cost_per_token: 0.000001 },
    aaa: { litellm_provider: "openai", input_cost_per_token: 0.000001 },
    "claude-x": { litellm_provider: "anthropic", input_cost_per_token: 0.000001 },
  })
  assert.deepEqual(Object.keys(catalog.providers), ["anthropic", "openai"])
  assert.deepEqual(Object.keys(catalog.providers.openai), ["aaa", "zzz"])
})

test("serializeCatalog is deterministic", () => {
  const upstream = {
    "gpt-4o": { litellm_provider: "openai", input_cost_per_token: 0.0000025 },
  }
  assert.equal(serializeCatalog(buildCatalog(upstream)), serializeCatalog(buildCatalog(upstream)))
})

test("PROVIDER_MAP targets only provider ids this app ships", () => {
  // Guards against mapping upstream providers onto ids the resolver will never
  // look up, which would silently bloat the artifact with dead entries.
  const shipped = new Set([
    "anthropic",
    "openai",
    "google",
    "deepseek",
    "groq",
    "mistral",
    "cohere",
    "xai",
    "togetherai",
    "fireworks",
    "cerebras",
    "openrouter",
    "ollama",
    "sambanova",
  ])
  for (const target of Object.values(PROVIDER_MAP)) {
    assert.ok(shipped.has(target), `PROVIDER_MAP targets unknown provider id "${target}"`)
  }
})

test("the committed artifact matches the generator's own invariants", () => {
  const committed = readCommittedCatalog()
  assert.ok(committed.source.startsWith("https://"))
  for (const [providerId, models] of Object.entries(committed.providers)) {
    assert.ok(Object.values(PROVIDER_MAP).includes(providerId), `unmapped provider ${providerId}`)
    for (const [modelId, entry] of Object.entries(models)) {
      assert.ok(
        entry.promptPer1M !== undefined || entry.completionPer1M !== undefined,
        `${providerId}/${modelId} has no base rate`
      )
      assert.ok(!modelId.includes("/"), `${providerId}/${modelId} kept a route prefix`)
    }
  }
})
