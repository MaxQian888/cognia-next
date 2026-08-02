/**
 * Permission seeding for the host-routed vector agent tools.
 *
 * The three tools are gated on the same `PluginAPIPermission` strings plugins
 * use (`vector:read`, `vector:write`, `ai:embed`), under the synthetic
 * `cognia-vector-builtin` subject. Unlike a real plugin there is no manifest
 * to seed grants from, so this module does it once per process the first time
 * a tool call is dispatched.
 *
 * Turning on `selfInvokeTools.vector` is the consent event — that is the
 * decision the user makes, and it is what causes the tools to be manifested at
 * all. Seeding here means the runtime check is not a no-op: `revokePermission`
 * (Settings → Plugins → Permissions, or a host policy through the permission
 * guard) takes the capability away again, and the runner then returns a typed
 * `permission` refusal for exactly the tools that needed it. That is how a
 * user gets read-only vector memory: revoke `vector:write` and `vector_search`
 * keeps working while the two mutating tools stop.
 */

import type { PluginAPIPermission } from "@/types/plugin/plugin"
import { grantPermission, pluginHasApiPermission } from "@/lib/plugin/api/permission-api"
import { VECTOR_BUILTIN_PLUGIN_ID } from "@/lib/claude/vector-builtin-tools"

/** Permissions seeded for the built-in subject on first use. */
export const VECTOR_BUILTIN_SEEDED_PERMISSIONS: readonly PluginAPIPermission[] = [
  "vector:read",
  "vector:write",
  "ai:embed",
]

let seeded = false

/**
 * Grant the built-in subject its three permissions, once. Idempotent, and a
 * no-op after a later revoke — re-granting on every call would make the gate
 * unrevokable, which is precisely what it must not be.
 */
export function ensureVectorBuiltinPermissions(): void {
  if (seeded) return
  seeded = true
  for (const permission of VECTOR_BUILTIN_SEEDED_PERMISSIONS) {
    // Skip anything already present so an existing (possibly narrowed) grant
    // set is never widened back out.
    if (!pluginHasApiPermission(VECTOR_BUILTIN_PLUGIN_ID, permission)) {
      grantPermission(VECTOR_BUILTIN_PLUGIN_ID, permission)
    }
  }
}

/** Test-only: allow the next `ensureVectorBuiltinPermissions()` to seed again. */
export function __resetVectorBuiltinPermissionsForTesting(): void {
  seeded = false
}
