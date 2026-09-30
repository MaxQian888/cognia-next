/**
 * Plugin contribution alignment (roadmap 2026-09-29, Phase 4; ADR-0203).
 *
 * `plugin_tool_invoke` runs any plugin tool under the single `plugin:tools`
 * scope. Once the bridge has dedicated `workspace:*` / `shell:run` scopes, a
 * plugin whose manifest reaches the filesystem or spawns processes would
 * otherwise be a side door around them: a client granted only `plugin:tools`
 * could read or run through a plugin what `workspace_read` / `shell_run` would
 * refuse it. So a plugin tool reached through the bridge needs, on top of
 * `plugin:tools`, every bridge scope its manifest permissions map to below.
 *
 * Plugins keep contributing tools the way they always have (ADR-0155: one host
 * door, no plugin-owned listeners or credentials); this only makes the bridge
 * grant the same decision for the same power, whichever door it comes in by.
 */

import type { BridgeScope } from "@/types/wiki"

/** Manifest permission → the bridge scope that grants the same power. */
export const PLUGIN_PERMISSION_BRIDGE_SCOPES: Readonly<Record<string, BridgeScope>> = {
  "filesystem:read": "workspace:read",
  "filesystem:write": "workspace:write",
  "shell:execute": "shell:run",
  "process:spawn": "shell:run",
  "tests:run": "shell:run",
  "python:execute": "shell:run",
  "notebook:execute": "shell:run",
}

/**
 * The bridge scopes a plugin's declared permissions require that the caller
 * does not hold, sorted and de-duplicated. Empty means the call may proceed.
 */
export function missingBridgeScopesForPlugin(
  declaredPermissions: readonly string[],
  grantedScopes: readonly string[]
): BridgeScope[] {
  const granted = new Set(grantedScopes)
  const missing = new Set<BridgeScope>()
  for (const permission of declaredPermissions) {
    const scope = PLUGIN_PERMISSION_BRIDGE_SCOPES[permission]
    if (scope && !granted.has(scope)) missing.add(scope)
  }
  return [...missing].sort()
}
