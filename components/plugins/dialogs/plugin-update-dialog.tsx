"use client"

// Update dialog — surfaces the marketplace updater's `checkForUpdates`
// output and lets the user apply singletons or batch-update everything.
// Reads from the lazy-loaded updater singleton so this dialog can mount
// inside a panel that doesn't always need the updater module.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon, RefreshCcwIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"

interface UpdateInfo {
  pluginId: string
  fromVersion: string
  toVersion: string
  changelog?: string
}

interface UpdaterClient {
  checkForUpdates: (pluginId?: string) => Promise<UpdateInfo[]>
  installUpdate: (pluginId: string, version: string) => Promise<unknown>
  cancelUpdate: (pluginId: string) => void
  onProgress: (handler: (progress: { pluginId: string; progress: number }) => void) => () => void
}

let cachedClient: UpdaterClient | null = null

async function loadUpdaterClient(): Promise<UpdaterClient> {
  if (cachedClient) return cachedClient
  const mod = (await import("@/lib/plugin/lifecycle/updater")) as unknown as {
    getPluginUpdater?: () => UpdaterClient
  }
  if (typeof mod.getPluginUpdater === "function") {
    cachedClient = mod.getPluginUpdater()
    return cachedClient
  }
  // Fall back to a no-op client when the updater module isn't wired up; the
  // dialog still renders an empty list rather than crashing.
  cachedClient = {
    checkForUpdates: async () => [],
    installUpdate: async () => undefined,
    cancelUpdate: () => undefined,
    onProgress: () => () => undefined,
  }
  return cachedClient
}

export function __resetPluginUpdateClientForTests(client: UpdaterClient | null) {
  cachedClient = client
}

interface Props {
  open: boolean
  onClose: () => void
}

export function PluginUpdateDialog({ open, onClose }: Props) {
  const t = useTranslations("plugins.update")
  const [updates, setUpdates] = useState<UpdateInfo[]>([])
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (!open) return
    let unsubscribe: (() => void) | undefined
    void (async () => {
      setRefreshing(true)
      const client = await loadUpdaterClient()
      const list = await client.checkForUpdates()
      setUpdates(list)
      unsubscribe = client.onProgress((p) =>
        setProgress((prev) => ({ ...prev, [p.pluginId]: p.progress }))
      )
      setRefreshing(false)
    })()
    return () => {
      unsubscribe?.()
    }
  }, [open])

  const refresh = async () => {
    setRefreshing(true)
    try {
      const client = await loadUpdaterClient()
      setUpdates(await client.checkForUpdates())
    } finally {
      setRefreshing(false)
    }
  }

  const installOne = async (info: UpdateInfo) => {
    setBusyId(info.pluginId)
    try {
      const client = await loadUpdaterClient()
      await client.installUpdate(info.pluginId, info.toVersion)
      setUpdates((prev) => prev.filter((u) => u.pluginId !== info.pluginId))
    } finally {
      setBusyId(null)
    }
  }

  const installAll = async () => {
    const client = await loadUpdaterClient()
    for (const info of updates) {
      setBusyId(info.pluginId)
      try {
        await client.installUpdate(info.pluginId, info.toVersion)
      } finally {
        setBusyId(null)
      }
    }
    setUpdates([])
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[95vw] max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs">
            {t("availableCount", { count: updates.length })}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={refresh}
            disabled={refreshing}
          >
            <RefreshCcwIcon className="size-3.5 mr-1.5" />
            {refreshing ? t("checking") : t("recheck")}
          </Button>
        </div>

        <Card className="p-0 flex-1 min-h-0 flex flex-col overflow-hidden">
          <ScrollArea className="flex-1 min-h-0">
            {updates.length === 0 ? (
              <p className="p-4 text-center text-sm text-muted-foreground">{t("upToDate")}</p>
            ) : (
              <ul className="divide-y">
                {updates.map((info) => (
                  <li key={info.pluginId} className="flex items-center gap-3 p-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{info.pluginId}</div>
                      <div className="text-xs text-muted-foreground">
                        v{info.fromVersion} → v{info.toVersion}
                      </div>
                      {busyId === info.pluginId && (
                        <Progress value={progress[info.pluginId] ?? 0} className="mt-2 h-1.5" />
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void installOne(info)}
                      disabled={busyId !== null}
                    >
                      <DownloadIcon className="size-3.5 mr-1.5" />
                      {t("install")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </Card>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
          <Button
            onClick={() => void installAll()}
            disabled={updates.length === 0 || busyId !== null}
          >
            {t("installAll")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
