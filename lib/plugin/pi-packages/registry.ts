/**
 * Registry of Pi coding-agent packages contributed by enabled plugins
 * (`manifest.piPackages`, capability `pi-package`, ADR-0210).
 *
 * Fed by the `OVERLAY_REGISTRY_CAPABILITIES` dispatch loop: an entry is
 * registered when its plugin is enabled and dropped by
 * `unregisterContributedPiPackagesByPlugin` when it is disabled or uninstalled.
 * Presence here therefore means "the owning plugin is enabled right now", which
 * is exactly the precondition for installing a package or loading it into a
 * hosted session.
 *
 * The def is stored verbatim next to the plugin's install root. Nothing here
 * resolves a path: `resolve.ts` does that, once, with every refusal typed —
 * including the `builtin://` pseudo-root, which must never reach `pi install`
 * or `-e` as if it were a directory.
 */

import { createOverlayRegistry } from "@/lib/plugin/registries/createOverlayRegistry"
import {
  formatPiPackageRef,
  parsePiPackageRef,
  type PluginPiPackageDef,
  type PluginPiPackageRef,
} from "@/types/plugin/plugin-pi-package"

/** One registered package: the manifest def plus where its plugin lives. */
export interface ContributedPiPackageEntry {
  def: PluginPiPackageDef
  /** `plugin.path` at enable time: an absolute directory, or `builtin://<id>`. */
  installRoot: string
}

/** A registry entry as consumers see it, with its stable reference. */
export interface ContributedPiPackage extends ContributedPiPackageEntry {
  ref: PluginPiPackageRef
  pluginId: string
}

const registry = createOverlayRegistry<ContributedPiPackageEntry>({
  name: "pi-package",
  keyFn: (id, _entry, opts) => formatPiPackageRef(opts?.pluginId ?? "", id),
  // Keys embed the plugin id, so two plugins can never collide; a re-register
  // by the same plugin (hot reload) refreshes its own entry.
  conflictPolicy: "first-wins-cross-plugin",
})

/**
 * Register one contributed package. Called by the overlay dispatch loop with
 * the plugin's install root; tolerant of a malformed def (validation already
 * reported it) so one bad entry never blocks the rest of the plugin.
 */
export function registerContributedPiPackage(
  def: PluginPiPackageDef,
  ctx: { pluginId: string; installRoot?: string }
): void {
  registry.register(def.id, { def, installRoot: ctx.installRoot ?? "" }, { pluginId: ctx.pluginId })
}

/** Drop every package a plugin contributed. Returns the number removed. */
export function unregisterContributedPiPackagesByPlugin(pluginId: string): number {
  return registry.unregisterByPlugin(pluginId)
}

function toContributed(entry: {
  id: string
  entry: ContributedPiPackageEntry
  pluginId?: string
}): ContributedPiPackage {
  const pluginId = entry.pluginId ?? ""
  return {
    ...entry.entry,
    pluginId,
    ref: formatPiPackageRef(pluginId, entry.entry.def.id),
  }
}

/** Every package contributed by an enabled plugin, in registration order. */
export function listContributedPiPackages(): ContributedPiPackage[] {
  return registry.entries().map(toContributed)
}

/** The registered package behind a reference, or `undefined`. */
export function getContributedPiPackage(ref: string): ContributedPiPackage | undefined {
  const parsed = parsePiPackageRef(ref)
  if (!parsed) return undefined
  const found = registry.getEntry(formatPiPackageRef(parsed.pluginId, parsed.packageId))
  if (!found) return undefined
  return toContributed({ id: parsed.packageId, ...found })
}

/** Subscribe to registry changes (React consumers pair this with `getRevision`). */
export const subscribeContributedPiPackages = registry.subscribe

/** Monotonic revision, bumped on every change. */
export const getContributedPiPackagesRevision = registry.getRevision

/** Test-only: clear the registry. */
export const __resetContributedPiPackagesForTesting = registry.__resetForTesting
