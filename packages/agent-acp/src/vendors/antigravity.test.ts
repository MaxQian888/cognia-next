import { antigravityAcpProfile } from "./antigravity"

describe("antigravityAcpProfile", () => {
  const modes = antigravityAcpProfile.permissionModes!

  it("maps only native execution modes and preserves the host don't-ask policy", () => {
    expect(modes.toNative("default")).toBe("default")
    expect(modes.toNative("acceptEdits")).toBe("auto_edit")
    expect(modes.toNative("bypassPermissions")).toBe("yolo")
    expect(modes.toNative("dontAsk")).toBe("default")
    expect(modes.toCanonical("auto_edit", undefined)).toBe("acceptEdits")
    expect(modes.toCanonical("yolo", undefined)).toBe("bypassPermissions")
    expect(modes.toCanonical("default", "dontAsk")).toBe("dontAsk")
    expect(modes.toCanonical("default", "bypassPermissions")).toBe("default")
  })

  it("refuses Plan and unknown native modes instead of silently degrading", () => {
    expect(() => modes.toNative("plan")).toThrow(/does not support Plan/)
    expect(() => modes.toCanonical("future-auto", "default")).toThrow(/unknown permission mode/)
    expect(modes.requireAdvertised?.fallback).toEqual(["default"])
    expect(modes.mandatoryApprovalMode).toBe("default")
  })

  it("declares the official system-prompt namespace and mandatory setup mode reset", () => {
    expect(antigravityAcpProfile.systemPromptNamespace).toBe("antigravity")
    expect(antigravityAcpProfile.reapplySessionMode).toBe(true)
  })
})
