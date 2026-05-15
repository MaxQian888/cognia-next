"use client"

/**
 * PluginDataManagement — per-plugin "Delete plugin data" card.
 *
 * Renders a list of plugins that have declared Dexie tables (i.e. have a row
 * in pluginDexieMeta). For each one shows the namespaced table list and a
 * "Delete data" button that calls uninstallPlugin({purgeData: true}).
 *
 * Two modes:
 *   - List mode (no `pluginId` prop): renders every plugin with a
 *     `pluginDexieMeta` row. Used as a global maintenance surface.
 *   - Single mode (`pluginId` prop): renders only the matching plugin's
 *     row, used inside the per-plugin detail Sheet (Data tab).
 */

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Trash2Icon, DatabaseIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
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
import { Badge } from "@/components/ui/badge"
import { getDb } from "@/lib/db/schema"
import { getPluginManager } from "@/lib/plugin/core/manager"

interface Props {
  /** When provided, only render the row for this plugin (used inside the
   * per-plugin detail Sheet). When omitted, render every plugin with a
   * `pluginDexieMeta` row (global maintenance surface). */
  pluginId?: string
}

export function PluginDataManagement({ pluginId }: Props = {}) {
  const t = useTranslations("settings.plugins.dataManagement")
  const [pending, setPending] = useState<string | null>(null)

  const registrations = useLiveQuery(() => {
    const table = getDb().pluginDexieMeta
    return pluginId ? table.where("pluginId").equals(pluginId).toArray() : table.toArray()
  }, [pluginId])

  if (!registrations || registrations.length === 0) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <DatabaseIcon className="h-4 w-4" />
          <span className="text-sm">{pluginId ? t("emptyForPlugin") : t("emptyForAll")}</span>
        </div>
      </Card>
    )
  }

  const handlePurge = async (id: string) => {
    setPending(id)
    try {
      const manager = getPluginManager()
      await manager.uninstallPlugin(id, { purgeData: true })
    } catch (err) {
      console.error(`Failed to purge data for plugin "${id}"`, err)
    } finally {
      setPending(null)
    }
  }

  return (
    <div
      className="space-y-3"
      data-testid={pluginId ? "plugin-data-management-single" : "plugin-data-management-list"}
    >
      {registrations.map((meta) => (
        <Card key={meta.pluginId} className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm">{meta.pluginId}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {meta.tableNames.map((name) => (
                  <Badge key={name} variant="secondary" className="font-mono text-xs">
                    {name}
                  </Badge>
                ))}
              </div>
            </div>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={pending === meta.pluginId}
                  data-testid={`delete-data-${meta.pluginId}`}
                >
                  <Trash2Icon className="h-4 w-4 mr-1.5" />
                  {t("deleteButton")}
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
                  <AlertDialogAction onClick={() => handlePurge(meta.pluginId)}>
                    {t("deleteDialog.confirm")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </Card>
      ))}
    </div>
  )
}
