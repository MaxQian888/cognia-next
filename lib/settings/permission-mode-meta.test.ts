import {
  ADVANCED_MODES,
  cyclePermissionMode,
  PERMISSION_MODE_META,
  PERMISSION_MODES,
  permissionModeMeta,
  permissionRiskMarker,
  SAFE_CYCLE_MODES,
} from "./permission-mode-meta"

describe("permission-mode-meta", () => {
  it("describes every permission mode exhaustively", () => {
    // The union has 6 members; the record must cover all of them.
    expect(PERMISSION_MODES).toHaveLength(6)
    for (const mode of PERMISSION_MODES) {
      const meta = PERMISSION_MODE_META[mode]
      expect(meta).toBeDefined()
      expect(["safe", "elevated", "danger"]).toContain(meta.risk)
      expect(meta.tone).toMatch(/^text-/)
      expect(meta.i18nKey).toBeTruthy()
    }
  })

  it("marks bypassPermissions as the only danger mode", () => {
    const danger = PERMISSION_MODES.filter((m) => PERMISSION_MODE_META[m].risk === "danger")
    expect(danger).toEqual(["bypassPermissions"])
  })

  it("keeps the safe core as default/acceptEdits/plan and everything else advanced", () => {
    expect(SAFE_CYCLE_MODES).toEqual(["default", "acceptEdits", "plan"])
    expect([...ADVANCED_MODES].sort()).toEqual(["auto", "bypassPermissions", "dontAsk"].sort())
  })

  describe("permissionRiskMarker", () => {
    it("returns a warning glyph only for danger, a dot for elevated, empty for safe", () => {
      expect(permissionRiskMarker("bypassPermissions")).toBe("⚠")
      expect(permissionRiskMarker("acceptEdits")).toBe("•")
      expect(permissionRiskMarker("default")).toBe("")
      expect(permissionRiskMarker("plan")).toBe("")
    })
  })

  describe("permissionModeMeta", () => {
    it("falls back to a safe entry for an unknown mode", () => {
      // @ts-expect-error deliberately probing the runtime fallback
      const meta = permissionModeMeta("not-a-mode")
      expect(meta.risk).toBe("safe")
    })
  })

  describe("cyclePermissionMode", () => {
    it("walks the safe core, representing default as null", () => {
      // null (default) → acceptEdits → plan → back to null (default)
      expect(cyclePermissionMode(null)).toBe("acceptEdits")
      expect(cyclePermissionMode("acceptEdits")).toBe("plan")
      expect(cyclePermissionMode("plan")).toBeNull()
    })

    it("treats an explicit default the same as null", () => {
      expect(cyclePermissionMode("default")).toBe("acceptEdits")
    })

    it("de-escalates a power mode back to the default slot instead of escalating", () => {
      expect(cyclePermissionMode("bypassPermissions")).toBeNull()
      expect(cyclePermissionMode("dontAsk")).toBeNull()
      expect(cyclePermissionMode("auto")).toBeNull()
    })

    it("never lands on a danger mode", () => {
      let mode: ReturnType<typeof cyclePermissionMode> = null
      for (let i = 0; i < 12; i++) {
        mode = cyclePermissionMode(mode)
        expect(mode).not.toBe("bypassPermissions")
      }
    })
  })
})
