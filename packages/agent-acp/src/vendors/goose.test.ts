import { gooseAcpProfile } from "./goose"

describe("gooseAcpProfile", () => {
  const modes = gooseAcpProfile.permissionModes!

  it("keeps edit-only and deny policies in the host broker", () => {
    expect(modes.toNative("acceptEdits")).toBe("approve")
    expect(modes.toNative("plan")).toBe("chat")
    expect(modes.toNative("bypassPermissions")).toBe("auto")
    expect(modes.toCanonical("approve", "dontAsk")).toBe("dontAsk")
    expect(modes.toCanonical("approve", "plan")).toBe("default")
  })

  it("starts with approval enabled and matches allow-lists by tool name", () => {
    expect(gooseAcpProfile.launchEnv).toEqual({ GOOSE_MODE: "approve" })
    expect(gooseAcpProfile.preApprovalMatchesToolName).toBe(true)
  })

  it("recovers the tool identity and classifies platform file operations", () => {
    const identity = gooseAcpProfile.toolIdentity!
    expect(identity({ goose: { toolCall: { toolName: "cognia-tools__read" } } })).toEqual({
      name: "mcp__cognia-tools__read",
      kind: undefined,
    })
    expect(identity({ goose: { toolCall: { toolName: "edit" } } })).toEqual({
      name: "edit",
      kind: "edit",
    })
    expect(identity({ goose: { toolCall: { toolName: "read" } } })?.kind).toBe("read")
    expect(identity({ goose: { toolCall: { toolName: "  " } } })).toBeUndefined()
    expect(identity(undefined)).toBeUndefined()
  })
})
