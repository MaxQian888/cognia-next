import { ACP_VENDOR_PROFILES } from "./vendor-profiles"

describe("ACP_VENDOR_PROFILES", () => {
  it("ships one frozen profile per vendor with unique ids and executables", () => {
    const ids = ACP_VENDOR_PROFILES.map((profile) => profile.id)
    expect(ids).toEqual(["kimi", "cline", "qoder", "goose", "devin", "opencode-acp"])
    expect(Object.isFrozen(ACP_VENDOR_PROFILES)).toBe(true)
    for (const profile of ACP_VENDOR_PROFILES) expect(Object.isFrozen(profile)).toBe(true)
    const commands = ACP_VENDOR_PROFILES.flatMap((profile) => profile.commandNames)
    expect(new Set(commands).size).toBe(commands.length)
  })

  it("round-trips every canonical mode a profile can express", () => {
    const modes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"] as const
    for (const profile of ACP_VENDOR_PROFILES) {
      const permissionModes = profile.permissionModes
      if (!permissionModes) continue
      for (const mode of modes) {
        const native = permissionModes.toNative(mode)
        expect(permissionModes.toNative(permissionModes.toCanonical(native, mode))).toBe(native)
      }
    }
  })
})
