"use client"

// Store-driven host for the uninstall confirmation.
//
// Lived inside `plugin-panel.tsx` until the phone body needed the same
// dialog. The uninstall itself (manager teardown, file removal, scheduled-job
// cleanup, the Dexie row, the optional cascade) lives in
// `usePluginUninstall` / `uninstallPluginForHost` so the Library, the detail
// header, the batch bar and the marketplace all run the same one. This host
// owns only the queue: it advances EXACTLY once per answer — after the
// uninstall settles on confirm, or on dismiss — so a batch uninstall walks
// every selected plugin instead of skipping every other one.

import { usePluginUninstall } from "@/hooks/plugins/use-plugin-uninstall"
import { usePluginsStore } from "@/stores/plugins"

import { PluginDeleteDialog } from "./plugin-delete-dialog"

export function PluginDeleteDialogHost() {
  const target = usePluginsStore((s) => s.deleteTarget)
  const setDeleteTarget = usePluginsStore((s) => s.setDeleteTarget)
  const advanceDeleteQueue = usePluginsStore((s) => s.advanceDeleteQueue)
  const uninstall = usePluginUninstall()

  // Reads the queue at call time rather than from a render-time snapshot: the
  // answer can land after the queue changed (a batch bar dismissal clears it).
  const advance = () => {
    if (usePluginsStore.getState().deleteQueue.length > 0) advanceDeleteQueue()
    else setDeleteTarget(null)
  }

  return (
    <PluginDeleteDialog
      // Remounted per target so the cascade box and pending state start fresh
      // for each plugin a batch walks through.
      key={target?.pluginId ?? "none"}
      open={target !== null}
      pluginName={target?.name ?? ""}
      onCancel={advance}
      onConfirm={async ({ cascade }) => {
        if (!target) return
        // Failure is reported by the hook's toast; the queue still moves on so
        // one plugin that refuses to uninstall doesn't strand the rest.
        await uninstall(target, { cascade })
        advance()
      }}
    />
  )
}
