import {
  DEFAULT_AUTO_ROUTER_SETTINGS,
  type AutoRoutingSettings,
} from "@cognia/provider-types/auto-router"
import {
  DEFAULT_ROUTER_FUSION_SETTINGS,
  normalizeRouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"

import { carriedFromJudge, disableLlmClassifier, enableLlmClassifier } from "./classifier-migration"

const off = () => structuredClone(DEFAULT_ROUTER_FUSION_SETTINGS)
const judgeUser: AutoRoutingSettings = {
  ...DEFAULT_AUTO_ROUTER_SETTINGS,
  enabled: true,
  routerModel: { provider: "openai", model: "gpt-5-mini", priority: 0 },
  cacheTTL: 120,
  judge: { enabled: true, uncertaintyBand: 0.1, timeoutMs: 2_500 },
}

describe("the LLM classifier absorbs the difficulty judge (D18)", () => {
  it("carries the judge's router model, a longer timeout and a changed cache over on the first enable", () => {
    const next = enableLlmClassifier(off(), judgeUser, 1_000)
    expect(next.llmClassifier).toEqual({
      enabled: true,
      routerProviderId: "openai",
      routerModelId: "gpt-5-mini",
      timeoutMs: 2_500,
      cacheTtlSeconds: 120,
      judgeMigration: {
        capturedAt: 1_000,
        judge: {
          judge: { enabled: true, uncertaintyBand: 0.1, timeoutMs: 2_500 },
          routerModel: { provider: "openai", model: "gpt-5-mini", priority: 0 },
          enableCache: true,
          cacheTTL: 120,
        },
        carried: ["routerModel", "timeoutMs", "cacheTtlSeconds"],
      },
    })
    expect(carriedFromJudge(next)).toEqual(["routerModel", "timeoutMs", "cacheTtlSeconds"])
    // Nothing else about Router + Fusion changes: the master and surfaces stay as they were.
    expect(next.enabled).toBe(false)
    expect(Object.values(next.surfaces).every((on) => on === false)).toBe(true)
  })

  it("keeps the classifier's 1500 ms when the judge had less, and keeps a switched-off cache off", () => {
    const next = enableLlmClassifier(
      off(),
      { ...judgeUser, enableCache: false, judge: { enabled: true, timeoutMs: 400 } },
      5
    )
    expect(next.llmClassifier.timeoutMs).toBe(1_500)
    expect(next.llmClassifier.cacheTtlSeconds).toBe(0)
    expect(next.llmClassifier.judgeMigration?.carried).toEqual(["routerModel", "cacheTtlSeconds"])
  })

  it("carries nothing from default legacy settings, and says so", () => {
    const next = enableLlmClassifier(off(), DEFAULT_AUTO_ROUTER_SETTINGS, 9)
    expect(next.llmClassifier).toMatchObject({
      enabled: true,
      timeoutMs: 1_500,
      cacheTtlSeconds: 600,
      judgeMigration: { capturedAt: 9, carried: [] },
    })
    expect(next.llmClassifier.routerProviderId).toBeUndefined()
    expect(carriedFromJudge(next)).toEqual([])
    const noAuto = enableLlmClassifier(off(), undefined, 9)
    expect(noAuto.llmClassifier.judgeMigration).toEqual({ capturedAt: 9, judge: null, carried: [] })
  })

  it("never overwrites what the user already set on the classifier", () => {
    const edited = normalizeRouterFusionSettings({
      llmClassifier: {
        routerProviderId: "anthropic",
        routerModelId: "claude-haiku-5",
        timeoutMs: 900,
        cacheTtlSeconds: 60,
      },
    })
    const next = enableLlmClassifier(edited, judgeUser, 1)
    expect(next.llmClassifier).toMatchObject({
      enabled: true,
      routerProviderId: "anthropic",
      routerModelId: "claude-haiku-5",
      timeoutMs: 900,
      cacheTtlSeconds: 60,
    })
    expect(next.llmClassifier.judgeMigration?.carried).toEqual([])
  })

  it("migrates only the first time; later enables just flip the switch", () => {
    const first = enableLlmClassifier(off(), judgeUser, 1_000)
    const userEdited = normalizeRouterFusionSettings({
      ...disableLlmClassifier(first),
      llmClassifier: { ...disableLlmClassifier(first).llmClassifier, timeoutMs: 1_200 },
    })
    expect(userEdited.llmClassifier.enabled).toBe(false)
    expect(carriedFromJudge(userEdited)).toEqual([])
    const again = enableLlmClassifier(
      userEdited,
      {
        ...judgeUser,
        routerModel: { provider: "anthropic", model: "claude-haiku-5", priority: 0 },
      },
      2_000
    )
    expect(again.llmClassifier).toMatchObject({
      enabled: true,
      routerProviderId: "openai",
      timeoutMs: 1_200,
      judgeMigration: { capturedAt: 1_000 },
    })
  })

  it("never modifies the legacy Auto settings it reads", () => {
    const autoRouting = structuredClone(judgeUser)
    enableLlmClassifier(off(), autoRouting, 1)
    expect(autoRouting).toEqual(judgeUser)
  })
})
