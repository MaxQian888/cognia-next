import { ACP_VENDOR_PROFILES } from "./vendor-profiles"

describe("ACP_VENDOR_PROFILES", () => {
  it("ships one frozen profile per vendor with unique ids and executables", () => {
    const ids = ACP_VENDOR_PROFILES.map((profile) => profile.id)
    expect(ids).toEqual([
      "antigravity-acp",
      "minimax-code",
      "kimi",
      "cline",
      "copilot-cli",
      "qoder",
      "goose",
      "grok",
      "devin",
      "opencode-acp",
      "auggie",
      "autohand-code",
      "codebuddy",
      "command-code",
      "kilocode",
      "mistral-vibe",
      "mimo-code",
      "hermes-agent",
      "oh-my-pi",
      "muse",
      "amp",
      "zcode",
    ])
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
        if (
          permissionModes.supportedCanonicalModes &&
          !permissionModes.supportedCanonicalModes.includes(mode)
        ) {
          expect(() => permissionModes.toNative(mode)).toThrow("cannot enforce")
          continue
        }
        if (profile.id === "amp" && mode !== "bypassPermissions") {
          expect(() => permissionModes.toNative(mode)).toThrow("cannot enforce")
          continue
        }
        if (profile.id === "antigravity-acp" && mode === "plan") {
          expect(() => permissionModes.toNative(mode)).toThrow("does not support Plan")
          continue
        }
        if (profile.id === "minimax-code" && (mode === "acceptEdits" || mode === "dontAsk")) {
          expect(() => permissionModes.toNative(mode)).toThrow("cannot enforce")
          continue
        }
        const native = permissionModes.toNative(mode)
        expect(permissionModes.toNative(permissionModes.toCanonical(native, mode))).toBe(native)
      }
    }
  })
})
