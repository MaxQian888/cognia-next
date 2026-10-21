/**
 * The plugin contract's share of `lib/plugin/api/companion-api.ts`, which re-exports these.
 */
import type { Goal } from "../../../types/goal"
import type { PairedDeviceRow } from "../../../types/mobile/paired-device"

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
