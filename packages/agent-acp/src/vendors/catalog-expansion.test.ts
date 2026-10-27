import { ACP_VENDOR_PROFILES } from "../vendor-profiles"
import {
  ampAcpProfile,
  autohandCodeAcpProfile,
  codebuddyAcpProfile,
  kilocodeAcpProfile,
  mistralVibeAcpProfile,
  mimoCodeAcpProfile,
  museAcpProfile,
  ohMyPiAcpProfile,
  zcodeAcpProfile,
} from "./catalog-expansion"

describe("audited ACP integrations", () => {
  it("resolves every newly wired agent without confusing sibling runtimes", () => {
    for (const id of [
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
      expect(ACP_VENDOR_PROFILES.some((profile) => profile.id === id)).toBe(true)
    expect(ohMyPiAcpProfile.commandNames).toEqual(["omp"])
  })

  it("does not pretend Amp can honor host approval lists or restrictive modes", () => {
    expect(() => ampAcpProfile.permissionModes!.toNative("default")).toThrow("cannot enforce")
    expect(ampAcpProfile.permissionModes!.toNative("bypassPermissions")).toBe("default")
    expect(() =>
      ampAcpProfile.validateConfiguration!({ requireApprovalFor: ["Bash"] } as never)
    ).toThrow("approval")
    expect(() => ampAcpProfile.validateConfigOption!("execution-environment", "orb")).toThrow("Orb")
  })

  it("refuses mandatory approval lists when native allow rules can skip ACP callbacks", () => {
    for (const id of [
      "auggie",
      "autohand-code",
      "codebuddy",
      "command-code",
      "kilocode",
      "mistral-vibe",
      "mimo-code",
      "muse",
      "hermes-agent",
      "oh-my-pi",
    ]) {
      const profile = ACP_VENDOR_PROFILES.find((entry) => entry.id === id)!
      expect(() => profile.validateConfiguration!({ requireApprovalFor: ["*"] } as never)).toThrow(
        "mandatory host approval"
      )
      expect(() =>
        profile.validateConfiguration!({
          requireApprovalFor: [],
          stateIsolation: "isolated",
        } as never)
      ).not.toThrow()
    }
  })

  it("restores approval-capable native modes without inheriting upstream auto-approval", () => {
    for (const [profile, execute] of [
      [autohandCodeAcpProfile, "default"],
      [codebuddyAcpProfile, "default"],
      [kilocodeAcpProfile, "build"],
      [mistralVibeAcpProfile, "ask"],
    ] as const) {
      expect(profile.reapplySessionMode).toBe(true)
      expect(profile.permissionModes!.toNative("default")).toBe(execute)
      for (const mode of ["dontAsk", "plan", "acceptEdits"] as const)
        expect(() => profile.permissionModes!.toNative(mode)).toThrow("cannot enforce")
      expect(profile.permissionModes!.toCanonical(execute, "default")).toBe("default")
      expect(profile.permissionModes!.toCanonical("unrecognized-permissive-mode", "dontAsk")).toBe(
        "bypassPermissions"
      )
    }
  })

  it("does not expose strict policy ceilings for native pre-approved tools", () => {
    for (const id of [
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
    ]) {
      const modes = ACP_VENDOR_PROFILES.find((profile) => profile.id === id)!.permissionModes!
      expect(modes.supportedCanonicalModes).toEqual(["default", "bypassPermissions"])
      for (const mode of ["plan", "dontAsk", "acceptEdits"] as const)
        expect(() => modes.toNative(mode)).toThrow("cannot enforce")
      expect(modes.toCanonical("plan", "plan")).not.toBe("plan")
    }
  })

  it("corrects MiMo terminal auth and retains Muse's per-tool boundary", () => {
    expect(mimoCodeAcpProfile.terminalAuth).toEqual({
      methodId: "opencode-login",
      command: "mimo",
      args: ["auth", "login"],
    })
    expect(museAcpProfile.launchEnv).toMatchObject({
      MUSE_APPROVAL_MODE: "promptUnmatched",
      MUSE_EDITOR_TOOLS: "1",
      MUSE_ALLOW_UNSCOPED_READS: "0",
    })
    expect(zcodeAcpProfile.promptCapabilityOverrides).toEqual({ image: false })
  })
})
