/**
 * The pure half only. Every input is a value, so the whole matrix
 * (rail x provider x model x preference) is reachable without a store or a DOM,
 * which is the property that lets `@cognia/plugin-sdk` publish this function
 * from its root barrel. The store-reading half has its own suite next door.
 */

import { FALLBACK_MODEL, FALLBACK_PROVIDER, resolveEffortSurface } from "./effort-surface"

describe("resolveEffortSurface", () => {
  /**
   * The lane, not the presence of a model, is what selects the external ladder.
   * An external agent brings its own model and the renderer never learns which,
   * so the session's provider/model pair describes a runtime that will not run.
   */
  it("answers the external ladder for the external rail, whatever the row says", () => {
    const surface = resolveEffortSurface({
      runtime: "external",
      sessionModel: "claude-opus-5",
      sessionProvider: "anthropic",
    })

    expect(surface.external).toBe(true)
    expect(surface.levels).not.toContain("max")
    // `ultracode` IS `xhigh` plus the workflow suite, and that surface folds
    // `xhigh` into `high`, so its name would promise depth the request cannot
    // carry.
    expect(surface.levels).not.toContain("ultracode")
    expect(surface.modelId).toBeUndefined()
  })

  it("prefers the session's own model and provider over the app defaults", () => {
    const surface = resolveEffortSurface({
      runtime: "claude-sdk",
      sessionModel: "gpt-5",
      sessionProvider: "openai",
      defaultModel: "claude-opus-5",
      defaultProvider: "anthropic",
    })

    expect(surface.modelId).toBe("gpt-5")
    expect(surface.providerId).toBe("openai")
  })

  it("falls back to the app defaults, then to the catalog's own", () => {
    expect(
      resolveEffortSurface({
        runtime: "claude-sdk",
        defaultModel: "claude-opus-5",
        defaultProvider: "anthropic",
      }).modelId
    ).toBe("claude-opus-5")

    const bare = resolveEffortSurface({ runtime: "claude-sdk" })
    expect(bare.modelId).toBe(FALLBACK_MODEL)
    expect(bare.providerId).toBe(FALLBACK_PROVIDER)
  })

  /** A model that does not reason at all gets no depth control, not a full ladder. */
  it("empties the ladder for a model that does not reason", () => {
    const surface = resolveEffortSurface({
      runtime: "claude-sdk",
      sessionModel: "gpt-4o",
      sessionProvider: "openai",
    })

    expect(surface.levels).toEqual([])
  })

  /**
   * Hiding a tier is presentation. It narrows what the control OFFERS and never
   * touches what a session holds, so `offered` keeps the unhidden ladder for
   * the settings UI that has to show what is available to hide.
   */
  it("narrows levels by the hidden-tier preference and keeps offered intact", () => {
    const surface = resolveEffortSurface({
      runtime: "claude-sdk",
      sessionModel: "claude-opus-5",
      sessionProvider: "anthropic",
      hiddenTiers: ["max", "ultracode"],
    })

    expect(surface.offered).toContain("max")
    expect(surface.levels).not.toContain("max")
    expect(surface.levels).not.toContain("ultracode")
  })

  /**
   * Reads nothing. The root barrel of `@cognia/plugin-sdk` publishes this, and
   * the root is types and pure functions only, so the same inputs have to give
   * the same answer with no store in the process.
   */
  it("is pure, so the same input answers the same twice", () => {
    const input = {
      runtime: "claude-sdk",
      sessionModel: "gpt-5",
      sessionProvider: "openai",
    } as const

    expect(resolveEffortSurface(input)).toEqual(resolveEffortSurface(input))
  })
})
