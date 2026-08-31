"use client"

// Store-driven host for the uninstall confirmation.
//
// Lived inside `plugin-panel.tsx` until the phone body needed the same
// dialog. The uninstall side effects (scheduled-task teardown, the optional
// cascade over stored permissions and analytics) are the part that must not be
// duplicated: a second copy is how one shell ends up leaving rows behind.

import { unregisterScheduledTasksForPlugin } from "@/lib/plugin/bridge/scheduled-task-bridge"
import { deletePlugin } from "@/lib/db/plugins"
import { getDb } from "@/lib/db/schema"
import { usePluginsStore } from "@/stores/plugins"

import { PluginDeleteDialog } from "./plugin-delete-dialog"

export function PluginDeleteDialogHost() {
  const target = usePluginsStore((s) => s.deleteTarget)
  const queueLength = usePluginsStore((s) => s.deleteQueue.length)
  const setDeleteTarget = usePluginsStore((s) => s.setDeleteTarget)
  const advanceDeleteQueue = usePluginsStore((s) => s.advanceDeleteQueue)
  // After confirm / cancel, advance to the next queued target so a batch
  // uninstall walks the whole selection without re-opening the bar.
  const advance = () => {
    if (queueLength > 0) advanceDeleteQueue()
    else setDeleteTarget(null)
  }
  return (
    <PluginDeleteDialog
      open={target !== null}
      pluginName={target?.name ?? ""}
      onCancel={advance}
      onConfirm={async ({ cascade }) => {
        if (!target) return
        const id = target.pluginId
        await unregisterScheduledTasksForPlugin(id)
        await deletePlugin(id)
        if (cascade) {
          const db = getDb()
          await Promise.all([
            db.pluginPermissions.where("pluginId").equals(id).delete(),
            db.pluginAnalytics.where("pluginId").equals(id).delete(),
          ])
        }
        advance()
      }}
    />
  )
}
