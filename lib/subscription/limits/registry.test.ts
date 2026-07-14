import { LIMITS_SOURCES, resolveLimitsSources } from "./registry"

import {
  __resetLimitsSourcesForTesting,
  registerLimitsSource,
} from "@/lib/plugin/registries/limits-source-registry"

import type { LimitsSource } from "@/types/subscription"

afterEach(() => __resetLimitsSourcesForTesting())

describe("LIMITS_SOURCES", () => {
  it("orders windowed sources before the balance fallthrough (volcengine ahead of anthropic)", () => {
    expect(LIMITS_SOURCES.map((s) => s.key)).toEqual([
      "volcengine",
      "anthropic",
      "codex",
      "balance",
    ])
  })
})

describe("resolveLimitsSources", () => {
  it("returns only anthropic for an anthropic account", () => {
    expect(resolveLimitsSources({ provider: "anthropic" }).map((s) => s.key)).toEqual(["anthropic"])
  })

  it("returns codex (window) for a chatgpt account, not balance", () => {
    expect(
      resolveLimitsSources({ provider: "codex", providerKey: "openai" }).map((s) => s.key)
    ).toEqual(["codex"])
  })

  it("returns only balance for a codex relay pointing at a credit provider", () => {
    expect(
      resolveLimitsSources({ provider: "codex", providerKey: "moonshot" }).map((s) => s.key)
    ).toEqual(["balance"])
  })

  it("returns [] when nothing matches", () => {
    expect(resolveLimitsSources({ provider: "opencode", providerKey: "groq" })).toEqual([])
  })

  it("resolves the volcengine source (ahead of anthropic) for a volces.com relay", () => {
    // A Volcengine relay account is provider `anthropic`; matching on its host
    // first means volcengine runs before the anthropic OAuth-usage source.
    expect(
      resolveLimitsSources({
        provider: "anthropic",
        providerKey: "volcengine-agentplan",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
      }).map((s) => s.key)
    ).toEqual(["volcengine", "anthropic"])
  })

  it("includes a built-in catalog descriptor (stepfun) ahead of the balance fallthrough", () => {
    expect(
      resolveLimitsSources({ provider: "opencode", providerKey: "stepfun" }).map((s) => s.key)
    ).toEqual(["stepfun"])
    expect(
      resolveLimitsSources({ provider: "opencode", baseUrl: "https://api.stepfun.com/v1" }).map(
        (s) => s.key
      )
    ).toEqual(["stepfun"])
  })

  it("lists plugin sources before the built-ins", () => {
    const plugin: LimitsSource = {
      key: "custom",
      matches: () => true,
      fetch: async () => null,
    }
    registerLimitsSource("p:custom", { ...plugin, id: "p:custom" }, { pluginId: "p" })
    const keys = resolveLimitsSources({ provider: "anthropic" }).map((s) => s.key)
    expect(keys[0]).toBe("custom")
    expect(keys).toContain("anthropic")
  })
})
