/**
 * The Default cogset (ADR-0209): created once, from what is enabled when the
 * host first runs with cogsets, so turning the feature on changes nothing the
 * user can see. It becomes the global and the applied cogset without a
 * reconciliation, because it already describes what is running.
 *
 * A host that already has cogsets (restored from a backup, or created on a
 * build that bootstrapped earlier and lost its state row) is only marked as
 * bootstrapped: inventing a Default next to the user's own sets would be
 * noise.
 */

import { stripSecretConfig } from "@/lib/plugin/core/config-secrets"
import type { CogsetMember, CogsetRow, CogsetStateRow } from "@/types/plugin/plugin-cogset"

/** Stored name of the bootstrapped cogset; the UI shows a localized label for it. */
export const DEFAULT_COGSET_NAME = "Default"

export interface BootstrapDefaultCogsetDeps {
  getState: () => Promise<CogsetStateRow>
  updateState: (patch: Partial<Omit<CogsetStateRow, "id" | "updatedAt">>) => Promise<CogsetStateRow>
  listCogsets: () => Promise<CogsetRow[]>
  createCogset: (draft: {
    name: string
    members: CogsetMember[]
    source: CogsetRow["source"]
  }) => Promise<CogsetRow>
  listInstalled: () => Promise<
    Array<{
      id: string
      enabled: boolean
      manifest: Record<string, unknown>
      config?: Record<string, unknown>
    }>
  >
  now: () => number
}

/** True when the Default cogset was created by this call. */
export async function ensureDefaultCogset(deps: BootstrapDefaultCogsetDeps): Promise<boolean> {
  const state = await deps.getState()
  if (state.defaultBootstrappedAt !== undefined) return false
  const at = deps.now()
  if ((await deps.listCogsets()).length > 0) {
    await deps.updateState({ defaultBootstrappedAt: at })
    return false
  }
  const alwaysOn = new Set(state.alwaysOn)
  const members: CogsetMember[] = (await deps.listInstalled())
    .filter((plugin) => plugin.enabled && !alwaysOn.has(plugin.id))
    .map((plugin) => {
      const config = stripSecretConfig(plugin.config, plugin.manifest)
      return Object.keys(config).length > 0
        ? { pluginId: plugin.id, config }
        : { pluginId: plugin.id }
    })
  const created = await deps.createCogset({
    name: DEFAULT_COGSET_NAME,
    members,
    source: { kind: "default" },
  })
  await deps.updateState({
    globalCogsetId: created.id,
    appliedCogsetId: created.id,
    appliedAt: at,
    defaultBootstrappedAt: at,
  })
  return true
}

/** The production wiring. */
export async function ensureDefaultCogsetOnHost(): Promise<boolean> {
  const [cogsets, plugins] = await Promise.all([
    import("@/lib/db/plugin-cogsets"),
    import("@/lib/db/plugins"),
  ])
  return ensureDefaultCogset({
    getState: cogsets.getCogsetState,
    updateState: (patch) => cogsets.updateCogsetState(patch),
    listCogsets: cogsets.listCogsets,
    createCogset: (draft) => cogsets.createCogset(draft),
    listInstalled: plugins.listPlugins,
    now: Date.now,
  })
}
