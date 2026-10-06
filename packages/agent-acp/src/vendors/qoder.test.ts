import { qoderAcpProfile } from "./qoder"

describe("qoderAcpProfile", () => {
  const modes = qoderAcpProfile.permissionModes!

  it("speaks snake_case mode ids", () => {
    expect(modes.toNative("acceptEdits")).toBe("accept_edits")
    expect(modes.toNative("bypassPermissions")).toBe("bypass_permissions")
    expect(modes.toNative("dontAsk")).toBe("dont_ask")
    expect(modes.toNative("plan")).toBe("plan")
    expect(modes.toCanonical("dont_ask", undefined)).toBe("dontAsk")
    expect(modes.toCanonical("unknown", "plan")).toBe("default")
  })

  it("refuses unadvertised modes with a conservative fallback set", () => {
    expect(modes.requireAdvertised?.fallback).toEqual(["default", "bypass_permissions"])
  })
})
