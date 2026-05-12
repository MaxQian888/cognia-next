"use client"

/**
 * PluginDataManagement — per-plugin "Delete plugin data" card.
 *
 * Renders a list of plugins that have declared Dexie tables (i.e. have a row
 * in pluginDexieMeta). For each one shows the namespaced table list and a
 * "Delete data" button that calls uninstallPlugin({purgeData: true}).
 *
 * Intended to be embedded in the plugins settings section (e.g. the
 * "installed" tab) as a collapsible card.
 */

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
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

export function PluginDataManagement() {
  const [pending, setPending] = useState<string | null>(null)

  const registrations = useLiveQuery(() => getDb().pluginDexieMeta.toArray())

  if (!registrations || registrations.length === 0) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <DatabaseIcon className="h-4 w-4" />
          <span className="text-sm">No plugins have declared custom data tables.</span>
        </div>
      </Card>
    )
  }

  const handlePurge = async (pluginId: string) => {
    setPending(pluginId)
    try {
      const manager = getPluginManager()
      await manager.uninstallPlugin(pluginId, { purgeData: true })
    } catch (err) {
      console.error(`Failed to purge data for plugin "${pluginId}"`, err)
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="space-y-3" data-testid="plugin-data-management">
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
                  Delete data
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete plugin data?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete all IndexedDB data for{" "}
                    <strong>{meta.pluginId}</strong>. The plugin itself will not be uninstalled, but
                    all stored records will be erased and cannot be recovered.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => handlePurge(meta.pluginId)}>
                    Delete
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
