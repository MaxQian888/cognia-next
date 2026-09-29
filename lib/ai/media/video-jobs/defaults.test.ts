import type { ProviderSettingsSnapshot } from "@/lib/ai/provider-consumption"
import {
  applyVideoDefaults,
  hasUsableVideoProvider,
  listConfiguredVideoProviders,
} from "./defaults"

function snapshot(providers: ProviderSettingsSnapshot["providers"]): ProviderSettingsSnapshot {
  return { defaultProvider: undefined, providers, customProviders: [] }
}

describe("configured video providers", () => {
  it("lists only providers that resolve, with their default model", () => {
    const listed = listConfiguredVideoProviders(
      snapshot({
        replicate: { enabled: true, apiKey: "r" },
        google: { enabled: true, apiKey: "g" },
        fal: { enabled: false, apiKey: "f" },
        openai: { enabled: true, apiKey: "o" },
      }),
      true
    )
    expect(listed.map((p) => p.providerId).sort()).toEqual(["google", "replicate"])
    expect(listed.find((p) => p.providerId === "replicate")).toEqual({
      providerId: "replicate",
      defaultModel: "minimax/video-01",
      reachable: true,
    })
  })

  it("marks providers the web build cannot reach as unreachable, not absent", () => {
    const settings = snapshot({
      replicate: { enabled: true, apiKey: "r" },
      google: { enabled: true, apiKey: "g" },
    })
    const listed = listConfiguredVideoProviders(settings, false)
    expect(listed.find((p) => p.providerId === "replicate")?.reachable).toBe(false)
    expect(listed.find((p) => p.providerId === "google")?.reachable).toBe(true)
    expect(hasUsableVideoProvider(settings, false)).toBe(true)
    expect(
      hasUsableVideoProvider(snapshot({ replicate: { enabled: true, apiKey: "r" } }), false)
    ).toBe(false)
    expect(hasUsableVideoProvider(snapshot({}), true)).toBe(false)
  })
})

describe("applyVideoDefaults", () => {
  const saved = {
    agentTool: true,
    providerId: "doubao",
    model: "seedance-1-5-pro-251215",
    durationSec: 5,
    aspectRatio: "16:9" as const,
    resolution: "1280x720" as const,
  }

  it("uses the saved provider, model and options when the call names none", () => {
    expect(applyVideoDefaults(saved, {}, ["doubao"])).toEqual({
      providerId: "doubao",
      model: "seedance-1-5-pro-251215",
      params: { durationSec: 5, aspectRatio: "16:9", resolution: "1280x720" },
    })
  })

  it("lets each override win over its default", () => {
    expect(
      applyVideoDefaults(saved, { durationSec: 10, model: "seedance-1-0-pro-250528" }, ["doubao"])
    ).toEqual({
      providerId: "doubao",
      model: "seedance-1-0-pro-250528",
      params: { durationSec: 10, aspectRatio: "16:9", resolution: "1280x720" },
    })
  })

  it("drops the saved model and options when the call picks another provider", () => {
    expect(applyVideoDefaults(saved, { providerId: "google" }, ["doubao", "google"])).toEqual({
      providerId: "google",
      params: {},
    })
  })

  it("keeps an explicit option even where the provider may refuse it", () => {
    // The engine owns that refusal; the defaults layer never rewrites a choice.
    expect(applyVideoDefaults(undefined, { providerId: "qwen", aspectRatio: "1:1" }, [])).toEqual({
      providerId: "qwen",
      params: { aspectRatio: "1:1" },
    })
  })

  it("skips saved options the saved provider does not take", () => {
    expect(
      applyVideoDefaults({ ...saved, providerId: "qwen", model: undefined }, {}, ["qwen"])
    ).toEqual({
      providerId: "qwen",
      params: { durationSec: 5, resolution: "1280x720" },
    })
  })

  it("ignores defaults for a saved provider that is no longer configured", () => {
    expect(applyVideoDefaults(saved, {}, ["google"])).toEqual({ params: {} })
  })

  it("has nothing to add without saved defaults", () => {
    expect(applyVideoDefaults({ agentTool: true }, {}, ["google"])).toEqual({ params: {} })
  })
})
