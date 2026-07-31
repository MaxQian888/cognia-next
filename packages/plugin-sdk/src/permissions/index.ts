/**
 * Plugin SDK — `permissions` subpath.
 *
 * Re-exports the permission identifiers a plugin declares in its manifest
 * and the policy/decision unions the host uses when granting them.
 *
 * Sources:
 *  - `types/plugin/plugin.ts` — `PluginPermission`,
 *    `PluginPermissionDecision`, `PluginPermissionPolicy`
 *  - `types/plugin/plugin.ts` — `PluginAPIPermission` (the
 *    complete permission union including extension-API-only permissions)
 *
 * The runtime permission API (`PluginPermissionAPI`) lives on
 * `PluginContext` and is re-exported from `@cognia/plugin-sdk/context`.
 */

export type {
  PluginPermission,
  PluginPermissionDecision,
  PluginPermissionPolicy,
} from "@/types/plugin/plugin"

export type { PluginAPIPermission } from "@/types/plugin/plugin"
