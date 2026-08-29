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

  // The codex source now matches on provider alone (the preset templateId is
  // not a reliable "is this a ChatGPT subscription" signal — Codex presets come
  // from the openai-compatible/openrouter catalog families). It declines at
  // `fetch` for an api_key credential or a non-ChatGPT base, so ordering it
  // ahead of balance stays correct: the relay still falls through to credit.
  it("tries codex before balance for a codex relay pointing at a credit provider", () => {
    expect(
      resolveLimitsSources({ provider: "codex", providerKey: "moonshot" }).map((s) => s.key)
    ).toEqual(["codex", "balance"])
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

  // StepFun has BOTH a catalog descriptor (plan window) and a balance adapter,
  // so the generic `balance` source matches too — the descriptor must still come
  // first so the runner prefers the window and only falls through to credit.
  it("includes a built-in catalog descriptor (stepfun) ahead of the balance fallthrough", () => {
    expect(
      resolveLimitsSources({ provider: "opencode", providerKey: "stepfun" }).map((s) => s.key)
    ).toEqual(["stepfun", "balance"])
    expect(
      resolveLimitsSources({ provider: "opencode", baseUrl: "https://api.stepfun.com/v1" }).map(
        (s) => s.key
      )
    ).toEqual(["stepfun", "balance"])
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
