/**
 * Plugin SDK - `companion` capability runtime surface.
 *
 * Re-exports the paired-device and remote-control API exposed as
 * `ctx.companion`, plus the host row/status types used by its methods.
 */

export { createCompanionAPI } from "@/lib/plugin/api/companion-api"

export type { CompanionServerStatus, PluginCompanionAPI } from "@/lib/plugin/api/companion-api"
export type { PairedDeviceRow } from "@cognia/plugin-contract/types/mobile/paired-device"
export type { Goal } from "@cognia/plugin-contract/types/goal"
