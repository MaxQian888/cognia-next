/**
 * @jest-environment node
 */
import { catalogModelIds } from "@/lib/ai/model-options"

import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { ResolvedConfig } from "../../config/schema"

import { collectModelOptions } from "./model-options"

const base = (over: Partial<ResolvedConfig>): ResolvedConfig => ({
  ...DEFAULT_RESOLVED_CONFIG,
  cwd: "/work",
  ...over,
})

describe("collectModelOptions", () => {
  it("leads with the active model then the active provider's catalog, de-duplicated", () => {
    const cfg = base({ provider: "anthropic", model: "my-pinned-model" })
    const list = collectModelOptions(cfg)
    expect(list[0]).toBe("my-pinned-model")
    // The shared Anthropic catalog is appended (reused desktop registry).
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

  it("keeps other providers' explicitly configured models reachable", () => {
    const cfg = base({ provider: "anthropic", providers: { customcorp: { model: "custom-x" } } })
    expect(collectModelOptions(cfg)).toContain("custom-x")
  })

  it("skips empty-string model ids", () => {
    const cfg = base({ provider: "uncatalogued", model: "", providers: { p: { model: "" } } })
    expect(collectModelOptions(cfg)).toEqual([])
  })

  it("includes the active provider's own configured model ahead of the catalog", () => {
    const cfg = base({ provider: "anthropic", providers: { anthropic: { model: "pinned-a" } } })
    const list = collectModelOptions(cfg)
    expect(list).toContain("pinned-a")
    expect(list.indexOf("pinned-a")).toBeLessThan(list.indexOf(catalogModelIds("anthropic")[0]))
  })

  it("does not duplicate an active model that is also in the catalog", () => {
    const active = catalogModelIds("anthropic")[0]
    const list = collectModelOptions(base({ provider: "anthropic", model: active }))
    expect(list.filter((m) => m === active)).toHaveLength(1)
    expect(list[0]).toBe(active)
  })
})
