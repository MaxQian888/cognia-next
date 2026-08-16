import { isAxisOnlyLegacyModeId, selectionFromLegacyModeId } from "./legacy-mode-mapping"

const KNOWN = new Set(["standard", "research", "writing", "my-custom-mode"])

describe("selectionFromLegacyModeId", () => {
  it("treats an absent id as a default, not a fallback", () => {
    // A session that predates the field must not show a compatibility warning.
    for (const value of [undefined, null, "", "   "]) {
      const migration = selectionFromLegacyModeId(value, KNOWN)
      expect(migration.selection).toEqual({ presetId: "standard" })
      expect(migration.warning).toBeUndefined()
    }
  })

  it("maps general to Standard with no axis overrides", () => {
    const { selection, warning } = selectionFromLegacyModeId("general", KNOWN)
    expect(selection).toEqual({ presetId: "standard", legacyModeId: "general" })
    expect(warning).toBeUndefined()
  })

  it("maps plan to Standard at plan authority", () => {
    expect(selectionFromLegacyModeId("plan", KNOWN).selection).toEqual({
      presetId: "standard",
      authority: "plan",
      legacyModeId: "plan",
    })
  })

  it("maps build to Standard at acceptEdits", () => {
    expect(selectionFromLegacyModeId("build", KNOWN).selection).toEqual({
      presetId: "standard",
      authority: "acceptEdits",
      legacyModeId: "build",
    })
  })

  it("maps workflow to Standard with workflow orchestration", () => {
    expect(selectionFromLegacyModeId("workflow", KNOWN).selection).toEqual({
      presetId: "standard",
      orchestration: "workflow",
      legacyModeId: "workflow",
    })
  })

  it("passes a known preset id through", () => {
    const { selection, warning } = selectionFromLegacyModeId("research", KNOWN)
    expect(selection).toEqual({ presetId: "research", legacyModeId: "research" })
    expect(warning).toBeUndefined()
  })

  it("passes a custom mode id through", () => {
    expect(selectionFromLegacyModeId("my-custom-mode", KNOWN).selection.presetId).toBe(
      "my-custom-mode"
    )
  })

  it("trims surrounding whitespace before matching", () => {
    expect(selectionFromLegacyModeId("  research  ", KNOWN).selection.presetId).toBe("research")
  })

  it("falls back to Standard at default authority for an unknown id", () => {
    const { selection, warning } = selectionFromLegacyModeId("mystery-mode", KNOWN)
    expect(selection).toEqual({
      presetId: "standard",
      authority: "default",
      legacyModeId: "mystery-mode",
    })
    expect(warning).toEqual({
      reason: "unknown-legacy-mode",
      requested: "mystery-mode",
      applied: "standard",
    })
  })

  it("never infers an elevated authority for an unknown id", () => {
    // The one rule that outranks fidelity: guessing wrong here grants writes.
    for (const id of ["bypass", "build-v2", "admin", "acceptEdits"]) {
      expect(selectionFromLegacyModeId(id, KNOWN).selection.authority).toBe("default")
    }
  })

  it("keeps the original id so an older client can round-trip the session", () => {
    expect(selectionFromLegacyModeId("mystery-mode", KNOWN).selection.legacyModeId).toBe(
      "mystery-mode"
    )
  })

  it("does not treat a preset id as known when the catalog is empty", () => {
    const { warning } = selectionFromLegacyModeId("research", new Set())
    expect(warning?.reason).toBe("unknown-legacy-mode")
  })
})

describe("isAxisOnlyLegacyModeId", () => {
  it("recognises the four ids that are not personas", () => {
    for (const id of ["general", "plan", "build", "workflow"]) {
      expect(isAxisOnlyLegacyModeId(id)).toBe(true)
    }
  })

  it("rejects domain modes and unknown ids", () => {
    expect(isAxisOnlyLegacyModeId("research")).toBe(false)
    expect(isAxisOnlyLegacyModeId("mystery-mode")).toBe(false)
  })

  it("is not fooled by inherited object properties", () => {
    expect(isAxisOnlyLegacyModeId("toString")).toBe(false)
    expect(isAxisOnlyLegacyModeId("constructor")).toBe(false)
  })
})
