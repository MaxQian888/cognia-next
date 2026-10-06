import { clineAcpProfile } from "./cline"

describe("clineAcpProfile", () => {
  const modes = clineAcpProfile.permissionModes!

  it("maps every executable mode to act and keeps the chosen one", () => {
    expect(modes.toNative("plan")).toBe("plan")
    expect(modes.toNative("bypassPermissions")).toBe("act")
    expect(modes.toCanonical("act", "acceptEdits")).toBe("acceptEdits")
    expect(modes.toCanonical("act", "plan")).toBe("default")
    expect(modes.toCanonical("plan", "acceptEdits")).toBe("plan")
  })

  it("refuses session MCP servers and withholds image prompts", () => {
    expect(clineAcpProfile.sessionMcpServersUnsupported).toMatch(/cline mcp/)
    expect(clineAcpProfile.promptCapabilityOverrides).toEqual({ image: false })
  })
})
