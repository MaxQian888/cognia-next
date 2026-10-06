import { getDecisionProbabilityKind, isDecisionCopilotValidated } from "./presets"
import { DECISION_HTTP_PRESET_IDS } from "@/types/decisions"
import { DECISION_HTTP_PRESETS, attributionHeaders, resolveDecisionEndpoint } from "./presets"

describe("DECISION_HTTP_PRESETS", () => {
  it("covers every preset id with https endpoints", () => {
    expect(Object.keys(DECISION_HTTP_PRESETS).sort()).toEqual([...DECISION_HTTP_PRESET_IDS].sort())
    for (const preset of Object.values(DECISION_HTTP_PRESETS)) {
      if (preset.url) expect(preset.url.startsWith("https://")).toBe(true)
    }
  })

  it("uses the two protocol paths", () => {
    expect(DECISION_HTTP_PRESETS.openrouter.url).toMatch(/\/api\/alpha\/decisions$/)
    for (const id of ["bocha", "typesafe", "vercel", "zen"] as const) {
      expect(DECISION_HTTP_PRESETS[id].url).toMatch(/\/v1\/systemone$/)
    }
  })
})

describe("resolveDecisionEndpoint", () => {
  it("resolves a preset with its default model", () => {
    expect(resolveDecisionEndpoint({ preset: "openrouter" })).toEqual({
      ok: true,
      preset: "openrouter",
      url: "https://openrouter.ai/api/alpha/decisions",
      model: "typesafe/jev-1.13",
    })
  })

  it("lets settings override url and model", () => {
    const resolved = resolveDecisionEndpoint({
      preset: "bocha",
      url: " https://gw.example.com/v1/systemone ",
      model: " custom-jev ",
    })
    expect(resolved).toMatchObject({
      url: "https://gw.example.com/v1/systemone",
      model: "custom-jev",
    })
  })

  it.each([
    [undefined, "no_preset"],
    [{ preset: "nope" }, "no_preset"],
    [{ preset: "custom" }, "no_url"],
    [{ preset: "custom", url: "not a url", model: "m" }, "bad_url"],
    [{ preset: "custom", url: "http://example.com/x", model: "m" }, "bad_url"],
    [{ preset: "custom", url: "https://example.com/x" }, "no_model"],
  ])("rejects %j", (http, reason) => {
    expect(resolveDecisionEndpoint(http as never)).toEqual({ ok: false, reason })
  })

  it("allows plain http only for loopback gateways", () => {
    expect(
      resolveDecisionEndpoint({
        preset: "custom",
        url: "http://127.0.0.1:8080/v1/systemone",
        model: "m",
      })
    ).toMatchObject({ ok: true })
  })
})

describe("attributionHeaders", () => {
  it("adds attribution only for OpenRouter", () => {
    expect(attributionHeaders("https://openrouter.ai/api/alpha/decisions")).toHaveProperty(
      "X-Title"
    )
    expect(attributionHeaders("https://jev.bocha.cn/v1/systemone")).toEqual({})
    expect(attributionHeaders("::::")).toEqual({})
  })
})

describe("decision adapter semantics", () => {
  it.each(["openai", "anthropic", "google"] as const)(
    "marks %s estimates as unvalidated",
    (preset) => {
      expect(getDecisionProbabilityKind({ preset })).toBe("estimated")
      expect(isDecisionCopilotValidated({ preset })).toBe(false)
    }
  )
  it("does not transfer Jev validation to overrides, custom or Gateway models", () => {
    expect(isDecisionCopilotValidated({ preset: "typesafe" })).toBe(true)
    expect(isDecisionCopilotValidated({ preset: "typesafe", model: "other" })).toBe(false)
    expect(
      isDecisionCopilotValidated({ preset: "typesafe", url: "https://other.test/systemone" })
    ).toBe(false)
    expect(
      isDecisionCopilotValidated({
        preset: "custom",
        model: "jev-latest",
        url: "https://other.test/systemone",
      })
    ).toBe(false)
    expect(isDecisionCopilotValidated({ preset: "gateway" })).toBe(false)
    expect(getDecisionProbabilityKind({ preset: "gateway" })).toBe("unknown")
  })
})
