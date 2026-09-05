/**
 * The companion server's lifecycle commands, shared by the Local host blocks.
 *
 * Lifted out of the retired `companion-section.tsx` unchanged: the legacy
 * grant import and the Locked Use reseed still ride every start, for the
 * reasons recorded on each function.
 */

import { listPairedDevices } from "@/lib/db/paired-devices"
import { transport } from "@/lib/tauri"
import type { TauriInvoker } from "@/lib/connectivity/mdns-discovery"

/**
 * Mirrors Rust `companion_api::server::DEFAULT_PORT`: 27890, outside the
 * 789x Clash mixed/SOCKS range so it cannot collide with a local proxy.
 */
export const DEFAULT_PORT = 27890

export type BindMode = "loopback" | "lan"

/** Mirror of the Rust `CompanionServerStatus` (`companion_api/commands.rs`). */
export interface CompanionServerStatus {
  running: boolean
  bindMode: "loopback" | "lan" | "none"
  boundPort: number | null
}

/** Mirror of the Rust `CompanionTlsPaths` (`companion_api/commands.rs`). */
export interface CompanionTlsPaths {
  certPemPath: string
  keyPemPath: string
  fingerprintSha256: string
}

export interface TunnelInfo {
  publicUrl: string
  localUrl: string
}

export interface TunnelConfig {
  mode: "quick" | "named"
  hostname?: string
  hasToken: boolean
}

export async function fetchServerStatus(): Promise<CompanionServerStatus> {
  return transport.call<CompanionServerStatus>("companion_server_status")
}

export async function startServer(bindMode: BindMode): Promise<number> {
  const port = await transport.call<number>("companion_server_start", {
    port: DEFAULT_PORT,
    bindLoopbackOnly: bindMode === "loopback",
  })
  // The three elevated grants live in the host's SecurityStore, which is
  // persistent, so nothing is re-projected at boot. All that is left is the
  // one-time import of the pre-migration Dexie flags, so an upgrading user
  // does not silently lose grants they had already made.
  await migrateLegacyDeviceGrants()
  await seedLockedComputerUseAllowList()
  return port
}

export async function stopServer(): Promise<void> {
  await transport.call<void>("companion_server_stop")
}

/**
 * Import the legacy Dexie grant flags into the host's SecurityStore, once.
 *
 * Deliberately not a per-boot reseed. The store is the authority now, so
 * re-projecting Dexie on every launch would let a stale mirror row resurrect a
 * grant that was revoked through the store (the `cognia-server devices` CLI,
 * the owner API). Rust guards the import behind a committed marker, so this is
 * a no-op after the first run. Best-effort: a failure leaves the store's own
 * grants untouched.
 */
export async function migrateLegacyDeviceGrants(): Promise<void> {
  try {
    const devices = await listPairedDevices()
    const live = devices.filter((d) => d.revokedAt === undefined)
    // Each grant comes from its own column, never derived from another: they
    // are independent, and inferring one from the other would quietly widen
    // whichever the user actually chose.
    await transport.call<boolean>("companion_migrate_legacy_device_grants", {
      control: live.filter((d) => d.allowRemoteControl === true).map((d) => d.deviceId),
      agentControl: live.filter((d) => d.allowAgentControl === true).map((d) => d.deviceId),
      terminal: live.filter((d) => d.allowRemoteTerminal === true).map((d) => d.deviceId),
    })
  } catch (err) {
    console.warn("migrateLegacyDeviceGrants failed", err)
  }
}

/**
 * Locked Use keeps its per-boot reseed: unlike the three grants above, its list
 * is in-memory and intentionally dormant, so Dexie is still its only truth.
 * See `src-tauri/src/companion_api/locked_use_allow_list.rs`.
 */
export async function seedLockedComputerUseAllowList(): Promise<void> {
  try {
    const devices = await listPairedDevices()
    const allowed = devices
      .filter(
        (device) =>
          device.allowRemoteControl === true &&
          device.allowLockedComputerUse === true &&
          device.revokedAt === undefined
      )
      .map((device) => device.deviceId)
    await transport.call<void>("companion_seed_locked_computer_use", { deviceIds: allowed })
  } catch (err) {
    console.warn("seedLockedComputerUseAllowList failed", err)
  }
}

/**
 * The `lib/connectivity` wrappers take an invoker so they stay testable off
 * Tauri. Handing them the routed transport keeps these blocks on the same call
 * every other control uses.
 */
export const transportInvoker = async (): Promise<TauriInvoker> => ({
  // Arity matters to the transport spies: `call(name, undefined)` is not
  // `call(name)`, so an argument-less command is forwarded argument-less.
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) =>
    args === undefined ? transport.call<T>(cmd) : transport.call<T>(cmd, args),
})

export async function startTunnel(localUrl: string): Promise<TunnelInfo> {
  return transport.call<TunnelInfo>("companion_tunnel_start", { localUrl })
}

export async function stopTunnel(): Promise<void> {
  await transport.call<void>("companion_tunnel_stop")
}

export async function getTunnelInfo(): Promise<TunnelInfo | null> {
  return transport.call<TunnelInfo | null>("companion_tunnel_current")
}

export async function getTunnelConfig(): Promise<TunnelConfig | null> {
  return transport.call<TunnelConfig | null>("companion_tunnel_get_config")
}

export async function setTunnelMode(mode: "quick" | "named"): Promise<void> {
  return transport.call<void>("companion_tunnel_set_mode", { mode })
}

export async function clearNamedTunnelConfig(): Promise<void> {
  return transport.call<void>("companion_tunnel_clear_named")
}

export async function getMdnsStatus(): Promise<boolean> {
  return transport.call<boolean>("companion_mdns_status")
}
