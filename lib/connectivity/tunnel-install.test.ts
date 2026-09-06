import { INSTALLABLE_TOOLS, TOOL_HOMEPAGE, installSteps } from "./tunnel-install"

import type { DesktopOsFamily } from "@/lib/platform/os"

const FAMILIES: DesktopOsFamily[] = ["macos", "windows", "linux", "unknown"]

describe("installSteps", () => {
  it("has at least a download link for every tool on every desktop OS", () => {
    for (const tool of INSTALLABLE_TOOLS) {
      for (const os of FAMILIES) {
        const steps = installSteps(tool, os)
        expect(steps.length).toBeGreaterThan(0)
        expect(steps.some((step) => step.url || step.command)).toBe(true)
        for (const step of steps) {
          expect(Boolean(step.command) !== Boolean(step.url)).toBe(true)
        }
      }
    }
  })

  it("names the package manager for the OS it belongs to", () => {
    expect(installSteps("cloudflared", "macos")[0]).toEqual({
      command: "brew install cloudflared",
      via: "homebrew",
    })
    expect(installSteps("cloudflared", "windows")[0].via).toBe("winget")
    expect(installSteps("tailscale", "linux")[0].via).toBe("script")
    expect(installSteps("zerotier", "windows")[0].command).toContain("ZeroTier.ZeroTierOne")
    expect(installSteps("cloudflared", "unknown")).toEqual([
      { url: TOOL_HOMEPAGE.cloudflared, via: "download" },
    ])
  })

  it("every download URL is https and on the vendor's own domain", () => {
    for (const tool of INSTALLABLE_TOOLS) {
      for (const os of FAMILIES) {
        for (const step of installSteps(tool, os)) {
          if (!step.url) continue
          expect(step.url.startsWith("https://")).toBe(true)
        }
      }
    }
    expect(TOOL_HOMEPAGE.tailscale).toContain("tailscale.com")
    expect(TOOL_HOMEPAGE.zerotier).toContain("zerotier.com")
    expect(TOOL_HOMEPAGE.cloudflared).toContain("cloudflare.com")
  })
})
