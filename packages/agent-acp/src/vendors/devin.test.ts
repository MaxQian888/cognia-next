import { devinAcpProfile } from "./devin"

describe("devinAcpProfile", () => {
  const modes = devinAcpProfile.permissionModes!

  it("maps modes and keeps dontAsk across the shared ask value", () => {
    expect(modes.toNative("acceptEdits")).toBe("accept-edits")
    expect(modes.toNative("dontAsk")).toBe("ask")
    expect(modes.toCanonical("ask", "dontAsk")).toBe("dontAsk")
    expect(modes.toCanonical("ask", "default")).toBe("default")
    expect(modes.toCanonical("bypass", undefined)).toBe("bypassPermissions")
  })

  it("recovers the programmatic tool name from cognition.ai metadata", () => {
    const identity = devinAcpProfile.toolIdentity!
    expect(
      identity({
        "cognition.ai/inferenceToolName": "mcp__cognia-tools__read",
        "cognition.ai/toolName": "x",
      })
    ).toEqual({ name: "mcp__cognia-tools__read" })
    expect(identity({ "cognition.ai/toolName": "shell" })).toEqual({ name: "shell" })
    expect(identity({ "cognition.ai/toolName": " " })).toBeUndefined()
  })
})
