/**
 * @jest-environment node
 */
import { catalogModelIds } from "@/lib/ai/model-options"
import {
  primeOpenRouterCatalogCache,
  __resetOpenRouterCatalogCacheForTesting,
} from "@cognia/provider-core/providers/openrouter-catalog-sync"

import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"

import { collectModelOptions, formatModelOptionLabel, modelInfoHint } from "./model-options"

afterEach(() => __resetOpenRouterCatalogCacheForTesting())

const base = (over: Partial<ResolvedConfig>): ResolvedConfig => ({
  ...DEFAULT_RESOLVED_CONFIG,
  cwd: "/work",
  ...over,
})

describe("collectModelOptions", () => {
  it("leads with the active provider's remembered model, then its catalog", () => {
    const cfg = base({ provider: "anthropic", providers: { anthropic: { model: "pinned-a" } } })
    const list = collectModelOptions(cfg)
    expect(list[0]).toBe("pinned-a")
    for (const id of catalogModelIds("anthropic")) expect(list).toContain(id)
    expect(new Set(list).size).toBe(list.length) // de-duplicated
  })

  it("returns the active provider's catalog even with nothing configured", () => {
    const list = collectModelOptions(base({ provider: "anthropic", providers: {} }))
    expect(list.length).toBeGreaterThan(0)
    expect(list).toEqual(catalogModelIds("anthropic"))
  })

  it("reflects the provider after a switch (openai → openai catalog)", () => {
    const anthropic = collectModelOptions(base({ provider: "anthropic", providers: {} }))
    const openai = collectModelOptions(base({ provider: "openai", providers: {} }))
    expect(openai).toEqual(catalogModelIds("openai"))
    expect(openai).not.toEqual(anthropic)
  })

  it("does NOT leak other providers' remembered models into the active list", () => {
    // The bug: another provider's model (a Claude id under anthropic) used to
    // surface as a placeholder in every provider's `/model` picker.
    const cfg = base({
      provider: "deepseek",
      providers: { anthropic: { model: "claude-sonnet-4-6" }, deepseek: {} },
    })
    const list = collectModelOptions(cfg)
    expect(list).not.toContain("claude-sonnet-4-6")
    expect(list).toEqual(catalogModelIds("deepseek"))
  })

  it("does NOT leak a stale top-level config.model into a catalogued provider", () => {
    const cfg = base({ provider: "openai", model: "claude-sonnet-4-6", providers: {} })
    const list = collectModelOptions(cfg)
    expect(list).not.toContain("claude-sonnet-4-6")
    expect(list).toEqual(catalogModelIds("openai"))
  })

  it("falls back to the top-level model only for an uncatalogued provider", () => {
    const cfg = base({ provider: "uncatalogued", model: "some-local-model", providers: {} })
    expect(collectModelOptions(cfg)).toEqual(["some-local-model"])
  })

  it("returns an empty list when an uncatalogued provider has no model at all", () => {
    const cfg = base({ provider: "uncatalogued", model: "", providers: {} })
    expect(collectModelOptions(cfg)).toEqual([])
  })

  it("does not duplicate the remembered model when it is also in the catalog", () => {
    const active = catalogModelIds("anthropic")[0]
    const cfg = base({ provider: "anthropic", providers: { anthropic: { model: active } } })
    const list = collectModelOptions(cfg)
    expect(list.filter((m) => m === active)).toHaveLength(1)
    expect(list[0]).toBe(active)
  })

  it("folds the synced OpenRouter catalog into the openrouter picker", () => {
    primeOpenRouterCatalogCache({
      id: "singleton",
      fetchedAt: 1,
      source: "remote",
      models: [
        { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
        { id: "openai/gpt-5", name: "GPT-5" },
      ],
    })
    const list = collectModelOptions(base({ provider: "openrouter", providers: {} }))
    expect(list).toContain("anthropic/claude-sonnet-4.5")
    expect(list).toContain("openai/gpt-5")
  })

  it("does not leak the OpenRouter catalog into a non-openrouter provider", () => {
    primeOpenRouterCatalogCache({
      id: "singleton",
      fetchedAt: 1,
      source: "remote",
      models: [{ id: "openai/gpt-5", name: "GPT-5" }],
    })
    const list = collectModelOptions(base({ provider: "anthropic", providers: {} }))
    expect(list).not.toContain("openai/gpt-5")
  })
})

describe("formatModelOptionLabel", () => {
  it("appends the display name when the catalog has a distinct one", () => {
    const id = catalogModelIds("anthropic")[0]
    const label = formatModelOptionLabel(id, "anthropic")
    expect(label).toContain(id)
    expect(label).toContain(" · ")
    expect(label.startsWith(id)).toBe(false) // name leads, id trails
  })

  it("renders the bare id when no friendly name is known", () => {
    expect(formatModelOptionLabel("totally-unknown-model-xyz", "anthropic")).toBe(
      "totally-unknown-model-xyz"
    )
  })
})

describe("modelInfoHint", () => {
  it("summarizes context window + capabilities from the shared catalog", () => {
    const id = catalogModelIds("anthropic")[0]
    const hint = modelInfoHint(id, "anthropic")
    expect(hint).toBeTruthy()
    // Anthropic flagship models carry a context window and tool support.
    expect(hint).toMatch(/K|M/)
    expect(hint).toContain("tools")
  })

  it("returns undefined for a model the catalog does not know", () => {
    expect(modelInfoHint("totally-unknown-model-xyz", "anthropic")).toBeUndefined()
  })

  it("returns undefined for an unknown provider", () => {
    expect(modelInfoHint("anything", "no-such-provider")).toBeUndefined()
  })

  it("enriches an OpenRouter catalog model the static subset doesn't carry", () => {
    primeOpenRouterCatalogCache({
      id: "singleton",
      fetchedAt: 1,
      source: "remote",
      models: [
        {
          id: "x-ai/grok-4",
          name: "Grok 4",
          contextLength: 256000,
          supportsTools: true,
          supportsVision: true,
        },
      ],
    })
    const hint = modelInfoHint("x-ai/grok-4", "openrouter")
    expect(hint).toMatch(/K|M/)
    expect(hint).toContain("tools")
    expect(hint).toContain("vision")
  })
})
