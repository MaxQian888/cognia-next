"use client"

/**
 * Plugin updates.
 *
 * This adapter does not install anything itself. The plugin lifecycle already
 * owns staging, permission re-review, backup, hot activation and rollback, and
 * duplicating any of that here would give plugins two installers that disagree.
 *
 * What it adds is the trust layer the marketplace does not have: a catalog
 * revocation check before a version is ever offered, and a provenance label so
 * a build the control plane has never seen is shown as unsigned rather than
 * silently treated like a signed one.
 */

import type { UpdateCandidate } from "@cognia/agent-config-types"

import type {
  UpdateAdapter,
  UpdateApplyContext,
  UpdateApplyResult,
  UpdateCheckContext,
} from "../adapter"
import { isRevokedRelease, releaseProvenance } from "../catalog-lookup"

export interface PluginUpdateInfoLike {
  pluginId: string
  currentVersion: string
  latestVersion: string
  changelog?: string
  breaking?: boolean
  minAppVersion?: string
  downloadSize?: number
}

export interface PluginUpdateResultLike {
  success: boolean
  error?: string
  requiresRestart?: boolean
}

export interface PluginAdapterDeps {
  checkForUpdates?: () => Promise<PluginUpdateInfoLike[]>
  update?: (pluginId: string) => Promise<PluginUpdateResultLike>
  /** True when applying this version widens the plugin's granted permissions. */
  permissionsExpanded?: (pluginId: string, version: string) => Promise<boolean>
  isSupported?: () => boolean
}

export function createPluginAdapter(deps: PluginAdapterDeps = {}): UpdateAdapter {
  const check = async () => {
    if (deps.checkForUpdates) return deps.checkForUpdates()
    const { getPluginUpdater } = await import("@/lib/plugin/lifecycle/updater")
    return getPluginUpdater().checkForUpdates() as unknown as Promise<PluginUpdateInfoLike[]>
  }

  return {
    kind: "plugin",
    executor: "plugin-runtime",
    isSupported: () => deps.isSupported?.() ?? true,

    async check(context: UpdateCheckContext): Promise<UpdateCandidate[]> {
      const infos = await check()
      const candidates: UpdateCandidate[] = []
      for (const info of infos) {
        if (isRevokedRelease(context.catalog, "plugin", info.pluginId, info.latestVersion)) continue
        const expanded =
          (await deps.permissionsExpanded?.(info.pluginId, info.latestVersion)) ?? undefined
        candidates.push({
          assetId: info.pluginId,
          kind: "plugin",
          executor: "plugin-runtime",
          currentVersion: info.currentVersion,
          targetVersion: info.latestVersion,
          channel: context.channel,
          criticality: "routine",
          compatibility: {
            minAppVersion: info.minAppVersion,
            breaking: info.breaking,
          },
          releaseNotes: info.changelog,
          sizeBytes: info.downloadSize,
          permissionsExpanded: expanded,
          source: "marketplace",
          provenance: releaseProvenance(
            context.catalog,
            "plugin",
            info.pluginId,
            info.latestVersion
          ),
        })
      }
      return candidates
    },

    async apply(
      candidate: UpdateCandidate,
      _context: UpdateApplyContext
    ): Promise<UpdateApplyResult> {
      const update =
        deps.update ??
        (async (pluginId: string) => {
          const { getPluginUpdater } = await import("@/lib/plugin/lifecycle/updater")
          return getPluginUpdater().update(pluginId) as unknown as PluginUpdateResultLike
        })
      const result = await update(candidate.assetId)
      if (!result.success) {
        return {
          state: "failed",
          failure: {
            kind: "unknown",
            code: "plugin_update_failed",
            recoveryActionKey: "openPluginSettings",
          },
        }
      }
      return { state: result.requiresRestart ? "awaiting-restart" : "verified" }
    },
  }
}
