import type { DecisionProvider } from "@/types/decisions"
import { createDecisionRegistry, toDecisionProviderInfo } from "./registry"

function provider(id: string, pluginId?: string): DecisionProvider {
  return {
    id,
    label: id,
    ...(pluginId ? { pluginId } : {}),
    locality: "local",
    calibrated: true,
    decide: async () => ({ ok: true, answers: {} }),
  }
}

describe("createDecisionRegistry", () => {
  it("registers, lists and unregisters", () => {
    const registry = createDecisionRegistry()
    registry.register(provider("a"))
    registry.register(provider("b"))
    expect(registry.list().map((p) => p.id)).toEqual(["a", "b"])
    expect(registry.get("a")?.id).toBe("a")
    expect(registry.unregister("a")).toBe(true)
    expect(registry.unregister("a")).toBe(false)
    expect(registry.list().map((p) => p.id)).toEqual(["b"])
  })

  it("refuses duplicate and empty ids", () => {
    const registry = createDecisionRegistry()
    registry.register(provider("a"))
    expect(() => registry.register(provider("a"))).toThrow(/already registered/)
    expect(() => registry.register(provider(""))).toThrow(/non-empty/)
  })

  it("keeps the list snapshot stable between changes", () => {
    const registry = createDecisionRegistry()
    registry.register(provider("a"))
    const first = registry.list()
    expect(registry.list()).toBe(first)
    registry.register(provider("b"))
    expect(registry.list()).not.toBe(first)
  })

  it("notifies subscribers on change only, and survives a throwing one", () => {
    const registry = createDecisionRegistry()
    const seen: string[] = []
    registry.subscribe(() => {
      throw new Error("bad subscriber")
    })
    const unsubscribe = registry.subscribe(() => seen.push(registry.list().length.toString()))
    registry.register(provider("a"))
    registry.unregister("missing")
    registry.clearForPlugin("nobody")
    unsubscribe()
    registry.register(provider("b"))
    expect(seen).toEqual(["1"])
  })

  it("clears only the named plugin's providers", () => {
    const registry = createDecisionRegistry()
    registry.register(provider("p1:x", "p1"))
    registry.register(provider("p1:y", "p1"))
    registry.register(provider("p2:x", "p2"))
    registry.register(provider("builtin"))
    registry.clearForPlugin("p1")
    expect(registry.list().map((p) => p.id)).toEqual(["p2:x", "builtin"])
  })
})

describe("toDecisionProviderInfo", () => {
  it("drops methods and empty optionals", () => {
    const info = toDecisionProviderInfo({
      ...provider("p:x", "p"),
      labelKey: "provider.label",
      limits: { headTokens: 192 },
      validatedQuestionSets: ["jev-judge/v1"],
      status: () => ({ ready: true }),
    })
    expect(info).toEqual({
      id: "p:x",
      label: "p:x",
      labelKey: "provider.label",
      pluginId: "p",
      locality: "local",
      calibrated: true,
      limits: { headTokens: 192 },
      validatedQuestionSets: ["jev-judge/v1"],
    })
    expect(Object.keys(toDecisionProviderInfo(provider("b")))).not.toContain("pluginId")
    expect(Object.keys(toDecisionProviderInfo(provider("b")))).not.toContain(
      "validatedQuestionSets"
    )
  })
})
