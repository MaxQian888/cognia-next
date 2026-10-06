import { openCodeAcpProfile } from "./opencode"

describe("openCodeAcpProfile", () => {
  const modes = openCodeAcpProfile.permissionModes!

  it("maps executable modes to build and keeps the session's choice on echo", () => {
    expect(modes.toNative("plan")).toBe("plan")
    expect(modes.toNative("bypassPermissions")).toBe("build")
    expect(modes.toCanonical("build", "acceptEdits")).toBe("acceptEdits")
    expect(modes.toCanonical("build", "plan")).toBe("default")
    expect(modes.toCanonical("plan", "default")).toBe("plan")
  })
})
