/**
 * @jest-environment jsdom
 */
import { resolveEffortSurface } from "./effort-surface"
import { PROVIDERS } from "@cognia/provider-types/provider"

/** The model a stock install actually runs on. */
const SHIPPED_DEFAULT = PROVIDERS.anthropic.defaultModel

describe("resolveEffortSurface — built-in Claude rail", () => {
  // The regression this whole module exists downstream of: the shipped default
  // model must publish a ladder, or the composer's control removes itself and
  // the feature reads as missing rather than off.
  it("offers a ladder on the shipped default model", () => {
    const surface = resolveEffortSurface({ runtime: "claude-sdk", defaultModel: SHIPPED_DEFAULT })
    expect(surface.levels.length).toBeGreaterThan(0)
    expect(surface.levels).toContain("ultracode")
    expect(surface.external).toBe(false)
  })

  it("offers Anthropic's full ladder on a Claude 5 model", () => {
    const surface = resolveEffortSurface({
      runtime: "claude-sdk",
      sessionProvider: "anthropic",
      sessionModel: "claude-opus-5",
    })
    expect(surface.levels).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"])
  })

  it("offers nothing on a model that rejects the effort parameter", () => {
    const surface = resolveEffortSurface({
      runtime: "claude-sdk",
      sessionProvider: "anthropic",
      sessionModel: "claude-haiku-4-5-20251001",
    })
    expect(surface.levels).toEqual([])
    expect(surface.offered).toEqual([])
  })

  it("prefers the session override over the app default", () => {
    const surface = resolveEffortSurface({
      runtime: "claude-sdk",
      sessionModel: "claude-haiku-4-5",
      sessionProvider: "anthropic",
      defaultModel: "claude-opus-5",
      defaultProvider: "anthropic",
    })
    // The session's (incapable) model wins, exactly as the send path resolves it.
    expect(surface.levels).toEqual([])
    expect(surface.modelId).toBe("claude-haiku-4-5")
  })

  it("narrows to the tiers a generic gateway keeps distinct", () => {
    const surface = resolveEffortSurface({
      runtime: "claude-sdk",
      sessionProvider: "deepseek",
      sessionModel: "deepseek-reasoner",
    })
    // That channel folds xhigh AND max onto `high`, so offering them would be
    // three controls with one effect — and `ultracode` would promise depth the
    // request cannot carry.
    expect(surface.levels).toEqual(["low", "medium", "high"])
  })
})

describe("resolveEffortSurface — external agent rail", () => {
  // The external agent brings its own model; the session's model describes a
  // runtime that is not going to execute the turn. Reading it produced a
  // six-tier ladder no ACP agent publishes, or no control at all.
  it("offers the generic ladder regardless of the session's model", () => {
    for (const sessionModel of ["claude-opus-5", "claude-haiku-4-5", undefined]) {
      const surface = resolveEffortSurface({ runtime: "external", sessionModel })
      expect(surface.levels).toEqual(["low", "medium", "high"])
      expect(surface.external).toBe(true)
    }
  })

  it("reports no model, because the renderer genuinely does not know it", () => {
    const surface = resolveEffortSurface({ runtime: "external", sessionModel: "claude-opus-5" })
    expect(surface.modelId).toBeUndefined()
    expect(surface.providerId).toBeUndefined()
  })

  it("never offers ultracode, whose extra half belongs to the built-in rail", () => {
    expect(resolveEffortSurface({ runtime: "external" }).levels).not.toContain("ultracode")
  })
})

describe("resolveEffortSurface — hidden-tier preference", () => {
  const base = {
    runtime: "claude-sdk" as const,
    sessionProvider: "anthropic",
    sessionModel: "claude-opus-5",
  }

  it("removes the hidden tiers from what the control offers", () => {
    const surface = resolveEffortSurface({ ...base, hiddenTiers: ["low", "xhigh", "max"] })
    expect(surface.levels).toEqual(["medium", "high", "ultracode"])
  })

  it("keeps the unfiltered ladder available for the settings UI", () => {
    const surface = resolveEffortSurface({ ...base, hiddenTiers: ["low", "medium"] })
    expect(surface.offered).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"])
  })

  it("refuses to empty the ladder", () => {
    // An empty ladder is the control's own "no depth here" signal: honouring a
    // hide-everything preference would unmount the only surface that can undo it.
    const surface = resolveEffortSurface({
      ...base,
      hiddenTiers: ["low", "medium", "high", "xhigh", "max", "ultracode"],
    })
    expect(surface.levels).toEqual(surface.offered)
  })

  it("does not resurrect a tier the surface never offered", () => {
    const surface = resolveEffortSurface({
      runtime: "claude-sdk",
      sessionProvider: "deepseek",
      sessionModel: "deepseek-reasoner",
      hiddenTiers: ["low"],
    })
    expect(surface.levels).toEqual(["medium", "high"])
  })

  it("leaves the ladder alone when nothing is hidden", () => {
    expect(resolveEffortSurface({ ...base, hiddenTiers: [] }).levels).toEqual(
      resolveEffortSurface(base).levels
    )
  })
})
