/**
 * Plugin Companion API (`ctx.companion`) — manage paired mobile devices, the
 * remote-control grants they hold, and (mirroring the companion remote-control
 * surface) steer the host's running goal loops. For "remote companion
 * dashboard" plugins that surface paired devices and let the owner act on them.
 *
 * Three permission tiers, each a deliberately scoped slice:
 *   - `companion:read`        — list paired devices + their remote-control grant
 *                               state + last-seen activity, and the server's
 *                               bind status. No mutations, no credentials.
 *   - `companion:control`     — grant / revoke a device's remote-control
 *                               capability and revoke / un-revoke a device.
 *                               Mirrors the desktop "Mobile companion" settings
 *                               card exactly: the authoritative Rust command +
 *                               the Dexie row mirror the UI reads from.
 *   - `companion:goal-control`— pause / resume / stop a host goal loop, the
 *                               same capability a paired device gets from the
 *                               remote-control grant (`goal_pause/resume/stop`).
 *
 * Why `companion:goal-control` is separate from `goal:write`: it is the narrow
 * "remote controller" slice — pause / resume / stop *existing* goals only. It
 * does NOT grant create / delete / decompose / objective-rewrite (that is the
 * full `goal:write` surface on `ctx.goals`). A companion plugin can steer a
 * running goal without taking the keys to the user's whole goal store.
 *
 * Desktop-only: the companion server + paired-device store only exist on the
 * Tauri host. Reads return empties on web; control calls reject via transport.
 */

import { transport } from "@/lib/tauri"
import {
  listPairedDevices,
  getPairedDevice,
  setRemoteControlAllowed,
  revokePairedDevice,
  resumePairedDevice,
} from "@/lib/db/paired-devices"
import { listAllGoals } from "@/lib/db/goals"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import type { Goal } from "@/types/goal"

/** Companion server bind status (mirrors Rust `CompanionServerStatus`). */
export interface CompanionServerStatus {
  running: boolean
  bindMode: string
  boundPort: number | null
}

/** Paired-device + remote-control management exposed to plugins. */
export interface PluginCompanionAPI {
  // ----------------------------------------------------- read (companion:read)
  /** Every paired device row (revoked / paused rows included; check fields). */
  listDevices(): Promise<PairedDeviceRow[]>
  /** A single paired device by id, or null. */
  getDevice(deviceId: string): Promise<PairedDeviceRow | null>
  /** Companion server bind status (running / bind mode / port). */
  serverStatus(): Promise<CompanionServerStatus>

  // ------------------------------------------------- control (companion:control)
  /** Grant or revoke a device's Remote Session Control capability. */
  setRemoteControl(deviceId: string, allowed: boolean): Promise<void>
  /** Hard-revoke a device (soft-delete + deny-list its JWT). */
  revokeDevice(deviceId: string): Promise<void>
  /** Reverse a revoke / pause — re-admit the device. */
  unrevokeDevice(deviceId: string): Promise<void>

  // ------------------------------------------ goal control (companion:goal-control)
  /** Open (active or paused) goals — the set a controller can act on. */
  listOpenGoals(): Promise<Goal[]>
  /** Pause a running host goal loop. */
  pauseGoal(goalId: string): Promise<Goal | null>
  /** Resume a paused host goal loop. */
  resumeGoal(goalId: string): Promise<Goal | null>
  /** Stop a host goal loop (terminal). */
  stopGoal(goalId: string): Promise<Goal | null>
}

/**
 * Create the Companion API for a plugin. Reads need `companion:read`; device
 * mutations need `companion:control`; goal steering needs
 * `companion:goal-control` (all enforced via the PermissionGuard proxy).
 */
export function createCompanionAPI(pluginId: string): PluginCompanionAPI {
  const runtime = getGoalRuntime()

  const api: PluginCompanionAPI = {
    // read
    listDevices: () => listPairedDevices(),
    getDevice: async (deviceId) => (await getPairedDevice(deviceId)) ?? null,
    serverStatus: () => transport.call<CompanionServerStatus>("companion_server_status", {}),

    // control — authoritative Rust command first, then the Dexie row the UI
    // mirrors (same order the "Mobile companion" settings card uses).
    setRemoteControl: async (deviceId, allowed) => {
      await transport.call<void>("companion_set_remote_control", { deviceId, allowed })
      await setRemoteControlAllowed(deviceId, allowed)
    },
    revokeDevice: async (deviceId) => {
      await transport.call<void>("companion_revoke_device", { deviceId })
      await revokePairedDevice(deviceId)
    },
    unrevokeDevice: async (deviceId) => {
      await transport.call<void>("companion_unrevoke_device", { deviceId })
      await resumePairedDevice(deviceId)
    },

    // goal control — the narrow pause/resume/stop slice (not full goal:write)
    listOpenGoals: async () => {
      const goals = await listAllGoals()
      return goals.filter((g) => g.status === "active" || g.status === "paused")
    },
    pauseGoal: (goalId) => runtime.pauseGoal(goalId),
    resumeGoal: (goalId) => runtime.resumeGoal(goalId),
    stopGoal: (goalId) => runtime.stopGoal(goalId),
  }

  return createGuardedAPI(pluginId, api, {
    listDevices: "companion:read",
    getDevice: "companion:read",
    serverStatus: "companion:read",
    setRemoteControl: "companion:control",
    revokeDevice: "companion:control",
    unrevokeDevice: "companion:control",
    listOpenGoals: "companion:goal-control",
    pauseGoal: "companion:goal-control",
    resumeGoal: "companion:goal-control",
    stopGoal: "companion:goal-control",
  })
}
