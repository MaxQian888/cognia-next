import { copilotAcpProfile } from "./copilot"
import type { AcpConfigOption } from "@cognia/agent-contracts/external-agent"

describe("copilotAcpProfile", () => {
  const modes = copilotAcpProfile.permissionModes!
  const prefix = "https://agentclientprotocol.com/protocol/session-modes#"
  const allow = (value: string): AcpConfigOption[] => [
    {
      id: "allow_all",
      name: "Allow All",
      category: "permissions",
      type: "select",
      currentValue: value,
      options: [
        { value: "on", name: "On" },
        { value: "off", name: "Off" },
      ],
    },
  ]

  it.each(["default", "acceptEdits", "dontAsk", "bypassPermissions"] as const)(
    "keeps %s in Agent mode and retains its host policy",
    (mode) => {
      expect(modes.toNative(mode)).toBe(`${prefix}agent`)
      expect(modes.toCanonical(`${prefix}agent`, mode, allow("off"))).toBe(mode)
    }
  )

  it("normalizes Plan and accurately reports native approval bypass", () => {
    expect(modes.toNative("plan")).toBe(`${prefix}plan`)
    expect(modes.toCanonical(`${prefix}plan`, undefined, allow("off"))).toBe("plan")
    expect(modes.toCanonical(`${prefix}agent`, "plan", allow("off"))).toBe("default")
    expect(modes.toCanonical(`${prefix}agent`, "dontAsk", allow("on"))).toBe("bypassPermissions")
    expect(modes.toCanonical(`${prefix}autopilot`, undefined, allow("off"))).toBe(
      "bypassPermissions"
    )
    expect(modes.toCanonical("unknown-mode", "bypassPermissions", allow("off"))).toBe("default")
    expect(modes.hostApprovalOption).toEqual({ id: "allow_all", value: "off" })
  })

  it("uses only the trusted Copilot login command arguments", () => {
    expect(copilotAcpProfile.terminalAuth).toEqual({ methodId: "copilot-login", args: ["login"] })
  })
})
