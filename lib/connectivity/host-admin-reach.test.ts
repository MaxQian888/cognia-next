import manifest from "@/protocol/companion-commands.json"
import en from "@/i18n/messages/en/settings/connectivity.json"
import zh from "@/i18n/messages/zh-CN/settings/connectivity.json"

import {
  DESKTOP_SHELL_COMMANDS,
  HOST_ADMIN_BLOCKS,
  hostAdminReachForCommand,
  hostAdminRequirementFor,
  resolveHostAdminReach,
} from "./host-admin-reach"

interface ManifestCommand {
  name: string
  target: string
  capability?: string
}

const commands = (manifest as { commands: ManifestCommand[] }).commands

describe("hostAdminRequirementFor", () => {
  it("routes every desktop-shell command to the desktop shell and the rest to host-admin", () => {
    for (const name of DESKTOP_SHELL_COMMANDS) {
      expect(hostAdminRequirementFor(name)).toBe("desktop-shell")
    }
    expect(hostAdminRequirementFor("companion_signaling_status")).toBe("host-admin")
    expect(hostAdminRequirementFor("companion_push_notification")).toBe("host-admin")
  })

  it("keeps the desktop-shell list in step with the manifest: none of them is on the host-admin plane", () => {
    const byName = new Map(commands.map((command) => [command.name, command]))
    for (const name of DESKTOP_SHELL_COMMANDS) {
      const entry = byName.get(name)
      expect(entry).toBeDefined()
      expect(entry?.target).not.toBe("host-admin")
    }
  })

  it("every companion_* command the Connectivity settings can call is either host-admin or desktop-shell", () => {
    const hostAdmin = commands.filter(
      (command) => command.target === "host-admin" && command.name.startsWith("companion_")
    )
    expect(hostAdmin.length).toBeGreaterThanOrEqual(14)
    for (const command of hostAdmin) {
      expect(command.capability).toBe("host.admin")
      expect(hostAdminRequirementFor(command.name)).toBe("host-admin")
    }
  })
})

describe("resolveHostAdminReach", () => {
  it("is always available on the Host itself", () => {
    expect(resolveHostAdminReach("desktop-shell", { profile: "desktop" })).toEqual({
      available: true,
    })
    expect(resolveHostAdminReach("host-admin", { profile: "headless" })).toEqual({
      available: true,
    })
  })

  it("blocks a standalone browser with no-host", () => {
    expect(resolveHostAdminReach("host-admin", { profile: "web-standalone" })).toEqual({
      available: false,
      block: "no-host",
    })
  })

  it("blocks a non-owner companion before anything else", () => {
    expect(
      resolveHostAdminReach("host-admin", { profile: "cloud-companion", isOwner: false })
    ).toEqual({ available: false, block: "not-owner" })
  })

  it("lets an owner companion reach host-admin but not the desktop shell", () => {
    expect(
      hostAdminReachForCommand("companion_signaling_configure", { profile: "cloud-companion" })
    ).toEqual({ available: true })
    expect(
      hostAdminReachForCommand("companion_tunnel_start", { profile: "mobile-companion" })
    ).toEqual({ available: false, block: "needs-desktop-shell" })
  })
})

describe("copy", () => {
  it("has a reason and a next step for every block in both locales", () => {
    for (const block of HOST_ADMIN_BLOCKS) {
      for (const bundle of [en, zh]) {
        expect(typeof bundle.reach[block]).toBe("string")
        expect(typeof bundle.reachNext[block]).toBe("string")
      }
    }
  })
})
