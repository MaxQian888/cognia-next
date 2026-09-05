/**
 * Can a Host-configuration control run from here, and if not, why?
 *
 * The Connectivity settings drive the Host's own connectivity: relay and
 * signaling, the browser-origin allowlist, push credentials, invitations,
 * the cloudflared tunnel, mDNS. Since ADR-0170 most of that is reachable
 * over the owner-authenticated `host-admin` RPC plane, so a browser talking
 * to a headless Host configures it exactly as the desktop renderer does.
 * Two things are not, and must say so instead of vanishing:
 *
 * - the tunnel is a child process of the desktop app,
 * - mDNS is a LAN multicast socket the desktop opens.
 *
 * Neither has a headless meaning, and a standalone browser has no Host at all.
 * Same shape as `lib/connectors/control-reach.ts`: one resolver, so the day
 * the manifest raises another command every control changes by editing this
 * file. Keeping this list in step with `protocol/companion-commands.json` is
 * pinned by the co-located test.
 */

import type { HostProfile } from "@/lib/platform/capabilities"

/** What a control needs from the Host. */
export type HostAdminRequirement =
  /** Reachable through the `host-admin` RPC plane on any Host kind. */
  | "host-admin"
  /** Needs the desktop process itself (tunnel child process, mDNS socket). */
  | "desktop-shell"

/** Why a control cannot run here. */
export type HostAdminBlock =
  /** A standalone browser: no Host to configure. */
  | "no-host"
  /** The active Host is headless and this control needs the desktop app. */
  | "needs-desktop-shell"
  /** Not the Host's owner: `host.admin` is the owner device's capability. */
  | "not-owner"

/** Every block, so the co-located test can prove each has copy in both locales. */
export const HOST_ADMIN_BLOCKS: readonly HostAdminBlock[] = Object.freeze([
  "no-host",
  "needs-desktop-shell",
  "not-owner",
] as const)

export interface HostAdminReach {
  available: boolean
  block?: HostAdminBlock
}

const AVAILABLE: HostAdminReach = Object.freeze({ available: true })

function blocked(block: HostAdminBlock): HostAdminReach {
  return { available: false, block }
}

/**
 * Commands that only the desktop process can answer. Everything else the
 * Connectivity settings call is on the host-admin plane (see
 * `src-tauri/src/companion_api/rpc/host_admin.rs`).
 */
export const DESKTOP_SHELL_COMMANDS: readonly string[] = Object.freeze([
  "companion_tunnel_start",
  "companion_tunnel_stop",
  "companion_tunnel_current",
  "companion_tunnel_get_config",
  "companion_tunnel_set_mode",
  "companion_tunnel_save_named_config",
  "companion_tunnel_clear_named",
  "companion_mdns_start",
  "companion_mdns_stop",
  "companion_mdns_status",
  "companion_mdns_browse",
  "companion_server_start",
  "companion_server_stop",
  "companion_tls_paths",
  "companion_test_local_reachability",
  "companion_reachability_get",
  "companion_reachability_set",
])

export function hostAdminRequirementFor(command: string): HostAdminRequirement {
  return DESKTOP_SHELL_COMMANDS.includes(command) ? "desktop-shell" : "host-admin"
}

export interface HostAdminContext {
  profile: HostProfile
  /**
   * Whether the paired device holds `host.admin`. Irrelevant on the desktop
   * itself (the renderer is the owner by construction). `undefined` reads as
   * "unknown", which is treated as owner so a control is never hidden on a
   * stale capability read. The Host's own 403 is the authoritative answer.
   */
  isOwner?: boolean
}

export function resolveHostAdminReach(
  requirement: HostAdminRequirement,
  context: HostAdminContext
): HostAdminReach {
  switch (context.profile) {
    case "desktop":
    case "headless":
      return AVAILABLE
    case "web-standalone":
      return blocked("no-host")
    case "mobile-companion":
    case "cloud-companion":
      if (context.isOwner === false) return blocked("not-owner")
      if (requirement === "desktop-shell") {
        // A mobile companion is paired to a desktop and a cloud companion to
        // a headless server. The tunnel and mDNS live in the desktop process,
        // and even a phone paired to a desktop cannot start that process's
        // child from a distance: the commands stay `target: client`.
        return blocked("needs-desktop-shell")
      }
      return AVAILABLE
  }
}

/** Convenience for a control that names its command. */
export function hostAdminReachForCommand(
  command: string,
  context: HostAdminContext
): HostAdminReach {
  return resolveHostAdminReach(hostAdminRequirementFor(command), context)
}
