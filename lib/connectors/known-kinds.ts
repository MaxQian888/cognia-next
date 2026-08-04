/**
 * Which connector kinds a Character Pack's `requires.connectors` can resolve
 * against.
 *
 * A deliberate leaf module: `validate-requires.ts` runs inside the synchronous
 * register loop and in unit tests, so it must not pull the whole connector
 * subsystem into the settings bundle or instantiate the connector bus.
 *
 * The available set is **built-in kinds that are actually buildable, plus
 * plugin-registered kinds**. It is NOT `ALL_PLATFORM_KINDS`: that union
 * reserves `email` / `kook` / `line` / `mattermost`, none of which has a branch
 * in `adapter-registry.ts::buildAdapterFromRow`. Treating a reserved-but-
 * unimplemented kind as available would silently swallow a genuine missing
 * dependency — the exact failure the warning exists to surface.
 */

import { CONNECTOR_METADATA } from "./adapter-metadata"

/** Built-in kinds with a real adapter behind them. Computed once. */
const BUILT_IN_AVAILABLE: ReadonlySet<string> = new Set(
  CONNECTOR_METADATA.filter((meta) => meta.status !== "planned").map((meta) => meta.type)
)

const pluginKinds = new Map<string, Set<string>>()

/** Record a connector kind contributed by a plugin. Idempotent. */
export function registerPluginConnectorKind(pluginId: string, type: string): void {
  let owned = pluginKinds.get(pluginId)
  if (!owned) {
    owned = new Set()
    pluginKinds.set(pluginId, owned)
  }
  owned.add(type)
}

/** Drop every kind contributed by `pluginId`. Returns how many were removed. */
export function unregisterPluginConnectorKindsByPlugin(pluginId: string): number {
  const owned = pluginKinds.get(pluginId)
  if (!owned) return 0
  const count = owned.size
  pluginKinds.delete(pluginId)
  return count
}

/** Every resolvable connector kind, sorted for stable display. */
export function listKnownConnectorKinds(): string[] {
  const out = new Set<string>(BUILT_IN_AVAILABLE)
  for (const owned of pluginKinds.values()) {
    for (const type of owned) out.add(type)
  }
  return [...out].sort()
}

export function isKnownConnectorKind(kind: string): boolean {
  if (BUILT_IN_AVAILABLE.has(kind)) return true
  for (const owned of pluginKinds.values()) {
    if (owned.has(kind)) return true
  }
  return false
}

export function __resetKnownConnectorKindsForTesting(): void {
  pluginKinds.clear()
}
