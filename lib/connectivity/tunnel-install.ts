/**
 * How to get the third-party networking clients a Host can lean on.
 *
 * Three programs, none of them ours, each installed by the user on the Host
 * machine: `cloudflared` for a public HTTPS name, and the Tailscale or
 * ZeroTier client for an overlay network that makes a phone anywhere look
 * like it is on the LAN. The settings surfaces used to say "not installed"
 * and stop. This is the one table of what to run, per OS, so both the
 * Connectivity tunnel block and the Connections tunnel tab show the same
 * steps and neither hard-codes a package manager's name in a component.
 *
 * Pure data. The labels are i18n keys resolved by the component that
 * renders a row, so a vendor's command line stays verbatim and the words
 * around it translate.
 */

import type { DesktopOsFamily } from "@/lib/platform/os"

export type InstallableTool = "cloudflared" | "tailscale" | "zerotier"

export interface InstallStep {
  /** A command to run in a terminal, verbatim. Absent for a download link. */
  command?: string
  /** A page to open, when the OS has an installer rather than a package. */
  url?: string
  /** i18n key under `settings.connectivity.tunnelInstall.via`. */
  via: "homebrew" | "winget" | "apt" | "script" | "download" | "appStore"
}

const CLOUDFLARED_DOWNLOADS =
  "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
const TAILSCALE_DOWNLOADS = "https://tailscale.com/download"
const ZEROTIER_DOWNLOADS = "https://www.zerotier.com/download/"

/** The vendor's own download page, for the row that always applies. */
export const TOOL_HOMEPAGE: Readonly<Record<InstallableTool, string>> = Object.freeze({
  cloudflared: CLOUDFLARED_DOWNLOADS,
  tailscale: TAILSCALE_DOWNLOADS,
  zerotier: ZEROTIER_DOWNLOADS,
})

const STEPS: Readonly<Record<InstallableTool, Readonly<Record<DesktopOsFamily, InstallStep[]>>>> =
  Object.freeze({
    cloudflared: {
      macos: [
        { command: "brew install cloudflared", via: "homebrew" },
        { url: CLOUDFLARED_DOWNLOADS, via: "download" },
      ],
      windows: [
        { command: "winget install --id Cloudflare.cloudflared", via: "winget" },
        { url: CLOUDFLARED_DOWNLOADS, via: "download" },
      ],
      linux: [
        {
          command:
            "curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null && sudo apt-get update && sudo apt-get install cloudflared",
          via: "apt",
        },
        { url: CLOUDFLARED_DOWNLOADS, via: "download" },
      ],
      unknown: [{ url: CLOUDFLARED_DOWNLOADS, via: "download" }],
    },
    tailscale: {
      macos: [
        { url: "https://apps.apple.com/app/tailscale/id1475387142", via: "appStore" },
        { command: "brew install --cask tailscale", via: "homebrew" },
      ],
      windows: [
        { command: "winget install --id tailscale.tailscale", via: "winget" },
        { url: TAILSCALE_DOWNLOADS, via: "download" },
      ],
      linux: [
        { command: "curl -fsSL https://tailscale.com/install.sh | sh", via: "script" },
        { url: TAILSCALE_DOWNLOADS, via: "download" },
      ],
      unknown: [{ url: TAILSCALE_DOWNLOADS, via: "download" }],
    },
    zerotier: {
      macos: [
        { command: "brew install --cask zerotier-one", via: "homebrew" },
        { url: ZEROTIER_DOWNLOADS, via: "download" },
      ],
      windows: [
        { command: "winget install --id ZeroTier.ZeroTierOne", via: "winget" },
        { url: ZEROTIER_DOWNLOADS, via: "download" },
      ],
      linux: [
        { command: "curl -s https://install.zerotier.com | sudo bash", via: "script" },
        { url: ZEROTIER_DOWNLOADS, via: "download" },
      ],
      unknown: [{ url: ZEROTIER_DOWNLOADS, via: "download" }],
    },
  })

/** The steps for one tool on one OS. Never empty: every OS has the download row. */
export function installSteps(tool: InstallableTool, os: DesktopOsFamily): readonly InstallStep[] {
  return STEPS[tool][os]
}

export const INSTALLABLE_TOOLS: readonly InstallableTool[] = Object.freeze([
  "cloudflared",
  "tailscale",
  "zerotier",
])
