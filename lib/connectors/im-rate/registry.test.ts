import type { PluginImRateSourceDef } from "@/types/plugin/plugin-im-rate-source"
import {
  __resetImRateSourcesForTesting,
  registerImRateSource,
} from "@/lib/plugin/registries/im-rate-source-registry"
import { resolveImRateSources, evaluateImRate } from "./registry"

function src(id: string, overrides: Partial<PluginImRateSourceDef> = {}): PluginImRateSourceDef {
  return {
    id,
    key: id,
    matches: () => true,
    evaluate: async () => null,
    ...overrides,
  }
}

const ctx = {
  adapterId: "tg",
  conversationKey: "telegram:tg:1",
  platform: "telegram",
  now: 1000,
}

describe("resolveImRateSources / evaluateImRate", () => {
  beforeEach(() => {
    __resetImRateSourcesForTesting()
  })

  it("returns only sources whose matches() passes, overlay order", () => {
    registerImRateSource("a", src("a", { matches: (q) => q.platform === "telegram" }))
    registerImRateSource("b", src("b", { matches: (q) => q.platform === "discord" }))
    const resolved = resolveImRateSources({ adapterId: "tg", platform: "telegram" })
    expect(resolved.map((s) => s.key)).toEqual(["a"])
  })

  it("evaluateImRate returns null when no sources are registered", async () => {
    expect(await evaluateImRate(ctx)).toBeNull()
  })

  it("evaluateImRate returns null when all sources allow / abstain", async () => {
    registerImRateSource("a", src("a", { evaluate: async () => ({ allow: true }) }))
    registerImRateSource("b", src("b", { evaluate: async () => null }))
    expect(await evaluateImRate(ctx)).toBeNull()
  })

  it("evaluateImRate returns the FIRST block decision (registration order)", async () => {
    registerImRateSource("a", src("a", { evaluate: async () => null }))
    registerImRateSource(
      "b",
      src("b", { key: "b", evaluate: async () => ({ allow: false, reason: "cap_hit" }) })
    )
    registerImRateSource(
      "c",
      src("c", { key: "c", evaluate: async () => ({ allow: false, reason: "later" }) })
    )
    expect(await evaluateImRate(ctx)).toEqual({ reason: "cap_hit", key: "b" })
  })

  it("a throwing source abstains rather than wedging the gate", async () => {
    registerImRateSource(
      "a",
      src("a", {
        evaluate: async () => {
          throw new Error("boom")
        },
      })
    )
    expect(await evaluateImRate(ctx)).toBeNull()
  })

  it("defaults the reason when a block omits it", async () => {
    registerImRateSource("a", src("a", { key: "a", evaluate: async () => ({ allow: false }) }))
    expect(await evaluateImRate(ctx)).toEqual({ reason: "plugin_rate_limited", key: "a" })
  })
})
