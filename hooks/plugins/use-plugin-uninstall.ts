"use client"

/**
 * The one uninstall path for every plugin surface.
 *
 * # The gap this closes
 *
 * The Library's confirm dialog used to delete the Dexie `plugins` row and stop.
 * The runtime kept running: the plugin's tools, hooks, views and scheduled
 * jobs stayed registered, its files stayed on disk, and the next launch's
 * discovery pass re-created the row, so "Uninstall" looked like it worked until
 * a restart undid it. The marketplace's Uninstall called a `uninstallPlugin`
 * method the marketplace client never had (an `as unknown as` cast hid it), so
 * it threw on every click.
 *
 * `PluginManager.uninstallPlugin` is the authority: it runs `onUninstall`,
 * unloads the runtime, removes the files, revokes permissions and secrets and
 * (with `purgeData`) the plugin's Dexie tables. The Dexie `plugins` row is the
 * one thing the manager does not own (discovery writes it, nothing on the
 * manager's uninstall path deletes it), so it is removed here afterwards.
 *
 * # Where uninstall is refused, and why it says so
 *
 * - A mirrored client (paired phone, web companion) owns no plugin runtime and
 *   the host exposes no queued uninstall command (`plugin_set_enabled` is the
 *   only plugin write in `MOBILE_OUTBOUND_COMMANDS`). Deleting the mirror row
 *   would be undone by the next `sync_pull`, so the action is labelled "remove
 *   it on your desktop" instead of pretending.
 * - A built-in plugin ships inside the app bundle: removing its row and runtime
 *   is undone by the next launch's discovery. Disabling is the real action.
 *
 * Both refusals are surfaced by `pluginUninstallBlockReason` so every surface
 * (row menu, detail header, batch bar, marketplace) disables the same way.
 */

import { useCallback } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { deletePlugin } from "@/lib/db/plugins"
import type { PluginRow } from "@/lib/db/plugin-types"
import { getDb } from "@/lib/db/schema"
import { unregisterScheduledTasksForPlugin } from "@/lib/plugin/bridge/scheduled-task-bridge"
import { getPluginManager } from "@/lib/plugin/core/manager"
import { isMirroredPluginClient } from "@/lib/plugin/core/set-plugin-enabled-for-host"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { usePluginsStore } from "@/stores/plugins"

import { pluginDetailHref } from "./plugin-links"
import { usePluginErrorMessage } from "./use-plugin-error-message"

export type PluginUninstallBlockReason = "mirrored" | "builtin"

/** Why this host cannot uninstall `row`, or `null` when it can. */
export function pluginUninstallBlockReason(
  row: Pick<PluginRow, "source"> | null | undefined
): PluginUninstallBlockReason | null {
  if (isMirroredPluginClient()) return "mirrored"
  if (row?.source === "builtin") return "builtin"
  return null
}

/** Raised when a mirrored client asks for an uninstall it cannot perform. */
export class PluginUninstallBlockedError extends Error {
  readonly pluginErrorCode = "uninstallMirrored" as const
  constructor(public readonly pluginId: string) {
    super(`Plugin "${pluginId}" can only be uninstalled on the host that runs it`)
    this.name = "PluginUninstallBlockedError"
  }
}

export interface UninstallPluginOptions {
  /** Also drop the plugin's stored data, permissions and analytics rows. */
  cascade?: boolean
}

/**
 * Uninstall `pluginId` on this host. Throws on failure; the Dexie row is only
 * removed after the manager succeeded, so a failed uninstall leaves a row the
 * user can still inspect and retry from.
 */
export async function uninstallPluginForHost(
  pluginId: string,
  options: UninstallPluginOptions = {}
): Promise<void> {
  if (isMirroredPluginClient()) throw new PluginUninstallBlockedError(pluginId)
  const cascade = options.cascade === true

  // A row with no runtime record (an imported draft that was never installed,
  // or a row left behind by an older build) has nothing for the manager to
  // tear down, and `uninstallPlugin` would reject it as "not found".
  if (usePluginStore.getState().plugins[pluginId]) {
    await getPluginManager().uninstallPlugin(pluginId, { purgeData: cascade })
  }

  await unregisterScheduledTasksForPlugin(pluginId)
  await deletePlugin(pluginId)
  if (cascade) {
    const db = getDb()
    await Promise.all([
      db.pluginPermissions.where("pluginId").equals(pluginId).delete(),
      db.pluginAnalytics.where("pluginId").equals(pluginId).delete(),
    ])
  }
}

export interface PluginUninstallTarget {
  pluginId: string
  name: string
}

/**
 * The React face of {@link uninstallPluginForHost}: toasts the outcome, and on
 * success clears every piece of panel state that still points at the plugin
 * (the open detail pane and the batch selection). Resolves `true` on success.
 */
export function usePluginUninstall(): (
  target: PluginUninstallTarget,
  options?: UninstallPluginOptions
) => Promise<boolean> {
  const t = useTranslations("plugins.lifecycleFeedback")
  const describe = usePluginErrorMessage()
  const router = useRouter()

  return useCallback(
    async (target, options = {}) => {
      try {
        await uninstallPluginForHost(target.pluginId, options)
      } catch (error) {
        toast.error(t("uninstallFailed", { name: target.name }), {
          description: describe(error),
          action: {
            label: t("viewDetails"),
            onClick: () => router.push(pluginDetailHref(target.pluginId)),
          },
        })
        return false
      }
      const panel = usePluginsStore.getState()
      if (panel.detailPluginId === target.pluginId) panel.closeDetail()
      if (panel.selection.has(target.pluginId)) panel.toggleSelection(target.pluginId)
      toast.success(t("uninstalled", { name: target.name }))
      return true
    },
    [t, describe, router]
  )
}
