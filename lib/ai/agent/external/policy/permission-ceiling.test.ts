import {
  buildDeclaredCapabilityProfile,
  negotiateCapabilityProfile,
} from "../capability/capability-profile"
import {
  attestsExternalPermissionMode,
  enforceExternalPermissionCeiling,
} from "./permission-ceiling"
import type { ExternalAgentProtocol } from "@/types/agent/external-agent"

describe("external hard permission ceilings", () => {
  it("accepts advertised plan mode but never assumes unknown capabilities support it", () => {
    expect(attestsExternalPermissionMode("acp", { permissionModes: ["plan"] }, "plan")).toBe(true)
    expect(attestsExternalPermissionMode("acp", undefined, "plan")).toBe(false)
    expect(attestsExternalPermissionMode("http", { permissionModes: ["plan"] }, "plan")).toBe(false)
    expect(attestsExternalPermissionMode("custom", { permissionModes: ["plan"] }, "plan")).toBe(
      false
    )
  })

  // A contributed adapter reports its own protocol id at runtime, outside the
  // shipped union, which is exactly the case this branch must refuse to trust.
  it.each(["custom", "plugin:agent"] as ExternalAgentProtocol[])(
    "accepts %s only with a live mode list and negotiated setter",
    (protocol) => {
      const profile = negotiateCapabilityProfile({
        protocol,
        adapter: { setSessionMode: () => undefined },
        liveFacts: {},
      })
      expect(
        attestsExternalPermissionMode(protocol, { permissionModes: ["plan"] }, "plan", profile)
      ).toBe(true)
      expect(attestsExternalPermissionMode(protocol, undefined, "plan", profile)).toBe(false)
      const noSetter = negotiateCapabilityProfile({ protocol, adapter: {}, liveFacts: {} })
      expect(
        attestsExternalPermissionMode(protocol, { permissionModes: ["plan"] }, "plan", noSetter)
      ).toBe(false)
    }
  )

  it("uses shipped adapter evidence for cold Codex and Pi without trusting user claims", () => {
    for (const protocol of ["codex-app-server", "pi-rpc"] as const) {
      const profile = buildDeclaredCapabilityProfile({ protocol })
      expect(attestsExternalPermissionMode(protocol, undefined, "plan", profile)).toBe(true)
      expect(
        attestsExternalPermissionMode(protocol, { permissionModes: ["default"] }, "plan", profile)
      ).toBe(false)
      const denied = buildDeclaredCapabilityProfile({
        protocol,
        userDeclared: { "permissions.set-mode": "unsupported" },
      })
      expect(attestsExternalPermissionMode(protocol, undefined, "plan", denied)).toBe(false)
    }
  })

  it("clamps both caller and configured permissions to the hard ceiling", () => {
    const caps = { permissionModes: ["plan", "default", "bypassPermissions"] as const }
    expect(
      enforceExternalPermissionCeiling(
        {
          permissionMode: "bypassPermissions",
          permissionCeiling: { permissionMode: "plan" },
        },
        "acp",
        { permissionModes: [...caps.permissionModes] },
        "bypassPermissions"
      )?.permissionMode
    ).toBe("plan")
    expect(
      enforceExternalPermissionCeiling(
        {
          permissionCeiling: { permissionMode: "default" },
        },
        "acp",
        { permissionModes: [...caps.permissionModes] },
        "bypassPermissions"
      )?.permissionMode
    ).toBe("default")
  })

  it.each([{ allowedTools: [] }, { disallowedTools: ["Write"] }, { mcpServers: [] }])(
    "refuses unsupported hard dimensions rather than treating them as preapprovals: %j",
    (restriction) => {
      expect(() =>
        enforceExternalPermissionCeiling(
          {
            permissionCeiling: { permissionMode: "plan", ...restriction },
          },
          "acp",
          { permissionModes: ["plan"] }
        )
      ).toThrow("tool, sandbox, or MCP ceiling")
    }
  )

  it("leaves ordinary executions unchanged and rejects unattested hard plans", () => {
    const options = { permissionMode: "default" as const }
    expect(enforceExternalPermissionCeiling(options, "http", undefined)).toBe(options)
    expect(() =>
      enforceExternalPermissionCeiling(
        {
          permissionCeiling: { permissionMode: "plan" },
        },
        "http",
        undefined
      )
    ).toThrow("cannot enforce")
  })
})
