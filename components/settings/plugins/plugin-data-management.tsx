"use client"

/**
 * PluginDataManagement — the Dexie tables a plugin owns, and "Delete data".
 *
 * Renders the plugins that have declared Dexie tables (i.e. have a row in
 * `pluginDexieMeta`). For each one it lists the tables and offers "Delete
 * data", which erases every row in them and keeps the plugin installed.
 *
 * "Delete data" used to call `uninstallPlugin(id, { purgeData: true })`
 * directly. That uninstalled the plugin (runtime, files, permissions,
 * secrets) behind a dialog promising the opposite, skipped the shared
 * uninstall path's guards and cascades (`hooks/plugins/use-plugin-uninstall`),
 * and reported failure only to the console. The dialog's promise is the
 * intent, so the action is now a real data purge (`clearPluginTables`):
 * nothing is unloaded or removed, the tables stay registered, and only their
 * rows go. Uninstalling, with or without data, stays on the shared path.
 *
 * A mirrored client (paired phone, web companion) owns no plugin runtime and
 * the plugin's data lives on the host, so the action is refused there with the
 * reason shown inline. The builtin refusal that applies to uninstall does not
 * apply here: clearing a bundled plugin's data does not remove the plugin.
 *
 * Two modes:
 *   - List mode (no `pluginId` prop): renders every plugin with a
 *     `pluginDexieMeta` row. A global maintenance surface.
 *   - Single mode (`pluginId` prop): renders only the matching plugin's
 *     row, used inside the plugin detail pane's Data tab.
 *
 * Flat by design: the Data tab draws the section heading and the hairline, so
 * this renders a divided list with no box of its own.
 */

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type Dexie from "dexie"
import { DatabaseIcon, Loader2Icon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { getDb } from "@/lib/db/schema"
import { clearPluginTables } from "@/lib/plugin/dexie/bridge"
import { fromNamespacedTableName } from "@/lib/plugin/dexie/namespace"
import { isMirroredPluginClient } from "@/lib/plugin/core/mirrored-client"

interface Props {
  /** When provided, only render the row for this plugin (used inside the
   * plugin detail pane). When omitted, render every plugin with a
   * `pluginDexieMeta` row (global maintenance surface). */
  pluginId?: string
}

/** The table's own name; the `<pluginId>:` prefix repeats the row's plugin. */
function logicalTableName(name: string): string {
  return fromNamespacedTableName(name)?.tableName ?? name
}

export function PluginDataManagement({ pluginId }: Props = {}) {
  const t = useTranslations("settings.plugins.dataManagement")
  const td = useTranslations("plugins.detailData.dataManagement")
  const [pending, setPending] = useState<string | null>(null)
  const mirrored = isMirroredPluginClient()

  const registrations = useLiveQuery(() => {
    const table = getDb().pluginDexieMeta
    return pluginId ? table.where("pluginId").equals(pluginId).toArray() : table.toArray()
  }, [pluginId])

  if (registrations === undefined) {
    // Still reading: an empty-state sentence here would flash a false "none".
    return (
      <div aria-busy="true" data-testid="plugin-data-management-loading">
        <Skeleton className="h-4 w-40" />
      </div>
    )
  }

  if (registrations.length === 0) {
    return (
      <p className="@container flex items-center gap-2 text-xs text-muted-foreground">
        <DatabaseIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{pluginId ? t("emptyForPlugin") : t("emptyForAll")}</span>
      </p>
    )
  }

  const handlePurge = async (id: string) => {
    setPending(id)
    try {
      const cleared = await clearPluginTables(() => getDb() as unknown as Dexie, id)
      toast.success(td("purged", { pluginId: id, count: cleared.length }))
    } catch (error) {
      toast.error(td("purgeFailed", { pluginId: id }), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setPending(null)
    }
  }

  return (
    <div
      className="@container space-y-2"
      data-testid={pluginId ? "plugin-data-management-single" : "plugin-data-management-list"}
    >
      {mirrored && (
        <p
          className="border-l-2 border-amber-500 pl-2 text-xs text-muted-foreground"
          data-testid="plugin-data-management-blocked"
        >
          {td("mirroredBlocked")}
        </p>
      )}
      <ul className="divide-y">
        {registrations.map((meta) => {
          const busy = pending === meta.pluginId
          return (
            <li
              key={meta.pluginId}
              className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0 @sm:flex-row @sm:items-start @sm:justify-between"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  {/* Single mode sits under the plugin's own pane, so the id
                      would only repeat the header. */}
                  {!pluginId && <span className="font-medium break-all">{meta.pluginId}</span>}
                  <span className="text-muted-foreground">
                    {td("tableCount", { count: meta.tableNames.length })}
                  </span>
                </p>
                <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {meta.tableNames.map((name) => (
                    <li key={name} className="font-mono text-[11px] break-all" title={name}>
                      {logicalTableName(name)}
                    </li>
                  ))}
                </ul>
              </div>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 self-start text-destructive hover:text-destructive pointer-coarse:h-10"
                    disabled={busy || mirrored}
                    data-testid={`delete-data-${meta.pluginId}`}
                  >
                    {busy ? (
                      <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2Icon className="size-3.5" aria-hidden="true" />
                    )}
                    {busy ? td("deleting") : t("deleteButton")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("deleteDialog.title")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("deleteDialog.description", { pluginId: meta.pluginId })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("deleteDialog.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => void handlePurge(meta.pluginId)}
                    >
                      {t("deleteDialog.confirm")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
