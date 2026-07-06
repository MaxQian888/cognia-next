import { isPermissionModeEscalation } from "./permission-mode-escalation"

describe("isPermissionModeEscalation", () => {
  it("flags moves into an autonomous mode from default/plan", () => {
    expect(isPermissionModeEscalation("default", "acceptEdits")).toBe(true)
    expect(isPermissionModeEscalation("default", "bypassPermissions")).toBe(true)
    expect(isPermissionModeEscalation("plan", "auto")).toBe(true)
    expect(isPermissionModeEscalation("plan", "dontAsk")).toBe(true)
  })

  it("flags climbing within the autonomous tier", () => {
    expect(isPermissionModeEscalation("acceptEdits", "bypassPermissions")).toBe(true)
    expect(isPermissionModeEscalation("acceptEdits", "dontAsk")).toBe(true)
  })

  it("treats a missing current mode as default", () => {
    expect(isPermissionModeEscalation(undefined, "acceptEdits")).toBe(true)
    expect(isPermissionModeEscalation(undefined, "default")).toBe(false)
    expect(isPermissionModeEscalation(undefined, "plan")).toBe(false)
  })

  it("does not flag de-escalation or lateral moves", () => {
    expect(isPermissionModeEscalation("bypassPermissions", "default")).toBe(false)
    expect(isPermissionModeEscalation("acceptEdits", "plan")).toBe(false)
    expect(isPermissionModeEscalation("auto", "dontAsk")).toBe(false) // equal rank
    expect(isPermissionModeEscalation("dontAsk", "auto")).toBe(false) // equal rank
    expect(isPermissionModeEscalation("default", "default")).toBe(false)
  })

  it("never flags a move toward a non-autonomous target", () => {
    expect(isPermissionModeEscalation("default", "plan")).toBe(false)
    expect(isPermissionModeEscalation("bypassPermissions", "plan")).toBe(false)
  })
})
