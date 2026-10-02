/**
 * Managed IDE Dev Mode, renderer side (ADR-0088, operations.mdx "Dev Mode").
 *
 * The switch belongs to the host (`cognia_plugin_runtime::managed_ide_dev`):
 * off by default, never persisted, and while it is off the host records no
 * broker trace and honours no `local-dev` receipt. This module mirrors it for
 * the renderer and owns the one thing that lives only here, the session's
 * permission simulation.
 *
 * Simulated decisions are per plugin and per permission (`deny`, `ask`,
 * `allow`), kept in memory only, and consulted by the managed IDE broker's
 * authorization path ({@link simulatedDecision}) only while Dev Mode is on.
 * Switching Dev Mode off drops them. A plugin with any simulation in force is
 * marked "simulated" in the trace and in the panel.
 *
 * This is not the `ManagedIdeDevMode` ADR-0016 deleted: that module had no
 * caller. This one is driven by the Plugin DevTools "Managed IDE" panel and
 * gates the broker, the verifier and the proxy pipeline.
 */

import type { PluginPermission } from "@/types/plugin"
import { isTauri } from "@/lib/platform/detect"

export type SimulatedDecision = "deny" | "ask" | "allow"

export interface ManagedIdeDevModeStatus {
  enabled: boolean
  /** Folders whose installs get a `local-dev` receipt while Dev Mode is on. */
  devPaths: string[]
}

const OFF: ManagedIdeDevModeStatus = { enabled: false, devPaths: [] }

let status: ManagedIdeDevModeStatus = OFF
const overrides = new Map<string, Map<PluginPermission, SimulatedDecision>>()
/** Registered dev folder → the plugin its `plugin.json` declares. */
const folderPlugins = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0

function changed(): void {
  version += 1
  for (const listener of listeners) listener()
}

/** Re-render on any change: the status, a simulation, or a reset. */
export function subscribeDevMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A token that changes with every update, for `useSyncExternalStore`. */
export function devModeVersion(): number {
  return version
}

export function devModeStatus(): ManagedIdeDevModeStatus {
  return status
}

/** Whether Dev Mode was on at the host when last read or set. */
export function isDevModeActive(): boolean {
  return status.enabled
}

function adopt(next: ManagedIdeDevModeStatus): ManagedIdeDevModeStatus {
  const wasOn = status.enabled
  status = { enabled: next.enabled === true, devPaths: [...(next.devPaths ?? [])] }
  // Off ends the session: nothing simulated outlives it.
  if (wasOn && !status.enabled) overrides.clear()
  for (const path of [...folderPlugins.keys()]) {
    if (!status.devPaths.includes(path)) folderPlugins.delete(path)
  }
  changed()
  return status
}

async function host<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>(command, args)
}

/** Read the host's switch. Off outside the desktop, where there is no host. */
export async function readDevModeStatus(): Promise<ManagedIdeDevModeStatus> {
  if (!isTauri()) return adopt(OFF)
  return adopt(await host<ManagedIdeDevModeStatus>("plugin_managed_ide_dev_mode_status"))
}

/** Switch Dev Mode at the host. Off also forgets the registered dev paths. */
export async function setDevModeEnabled(enabled: boolean): Promise<ManagedIdeDevModeStatus> {
  if (!isTauri()) throw new Error("MANAGED_IDE_DEV_MODE_DESKTOP_ONLY")
  return adopt(await host<ManagedIdeDevModeStatus>("plugin_managed_ide_dev_mode_set", { enabled }))
}

/** The host's answer to a registration: the canonical path it keeps. */
interface DevPathRegistration {
  path: string
  status: ManagedIdeDevModeStatus
}

/** Trust plugins installed from `path` for this Dev Mode session. */
export async function registerDevPath(path: string): Promise<ManagedIdeDevModeStatus> {
  const registered = await host<DevPathRegistration>("plugin_managed_ide_dev_path_register", {
    path,
  })
  return adopt(registered.status)
}

/**
 * Register a plugin's own folder: trusted like {@link registerDevPath}, and
 * watched by "Watch plugin folders" so an edit there reinstalls and reloads
 * `pluginId` (with a temporary proxy) while Dev Mode is on.
 */
export async function registerDevFolder(
  path: string,
  pluginId: string
): Promise<ManagedIdeDevModeStatus> {
  const registered = await host<DevPathRegistration>("plugin_managed_ide_dev_path_register", {
    path,
  })
  // Keyed by the canonical path: it is the form the file watcher reports.
  folderPlugins.set(registered.path, pluginId)
  return adopt(registered.status)
}

/** Registered plugin folders, each with the plugin it holds. */
export function devFolders(): Array<{ path: string; pluginId: string }> {
  if (!status.enabled) return []
  return [...folderPlugins].map(([path, pluginId]) => ({ path, pluginId }))
}

export async function unregisterDevPath(path: string): Promise<ManagedIdeDevModeStatus> {
  return adopt(
    await host<ManagedIdeDevModeStatus>("plugin_managed_ide_dev_path_unregister", { path })
  )
}

/**
 * Set or clear (`null`) one simulated decision. Refused while Dev Mode is
 * off: a simulation must never take effect outside a Dev Mode session.
 */
export function setSimulatedPermission(
  pluginId: string,
  permission: PluginPermission,
  decision: SimulatedDecision | null
): void {
  if (!status.enabled) throw new Error("MANAGED_IDE_DEV_MODE_OFF")
  const forPlugin = overrides.get(pluginId) ?? new Map<PluginPermission, SimulatedDecision>()
  if (decision === null) forPlugin.delete(permission)
  else forPlugin.set(permission, decision)
  if (forPlugin.size === 0) overrides.delete(pluginId)
  else overrides.set(pluginId, forPlugin)
  changed()
}

/** Every simulation in force, for the panel. */
export function simulatedPermissions(): Array<{
  pluginId: string
  permission: PluginPermission
  decision: SimulatedDecision
}> {
  if (!status.enabled) return []
  return [...overrides].flatMap(([pluginId, forPlugin]) =>
    [...forPlugin].map(([permission, decision]) => ({ pluginId, permission, decision }))
  )
}

/** The simulated decision for this check, or `undefined` to decide for real. */
export function simulatedDecision(
  pluginId: string,
  permission: PluginPermission
): SimulatedDecision | undefined {
  if (!status.enabled) return undefined
  return overrides.get(pluginId)?.get(permission)
}

/** Whether `pluginId` has any simulation in force (its "simulated" badge). */
export function isPluginSimulated(pluginId: string): boolean {
  return status.enabled && (overrides.get(pluginId)?.size ?? 0) > 0
}

/** Test seam: forget everything, as a fresh renderer would. */
export function resetDevModeForTests(): void {
  status = OFF
  overrides.clear()
  folderPlugins.clear()
  changed()
}
