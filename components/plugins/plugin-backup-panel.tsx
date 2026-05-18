"use client"

// Backup panel — surfaces `lib/plugin/lifecycle/backup.ts` so users can
// snapshot a plugin's state, list snapshots, restore, or prune. Lives in
// the detail surface of a plugin (one-per-plugin scope) rather than the
// global panel because backups are tied to a plugin id.
//
// The backup manager performs writes through `invoke()` (Tauri); in the
// web build only the in-memory list is readable. Mutating actions are
// disabled with a hint, so the panel still surfaces the existing
// snapshot index without exploding.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ArchiveIcon, Trash2Icon, RotateCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { getPluginBackupManager, type PluginBackup } from "@/lib/plugin/lifecycle/backup"
import { isTauri } from "@/lib/tauri"

interface BackupClient {
  createBackup: (
    pluginId: string
  ) => Promise<{ success: boolean; backup?: PluginBackup; error?: string }>
  restore: (backupId: string) => Promise<unknown>
  getBackups: (pluginId: string) => PluginBackup[]
  deleteBackup: (backupId: string) => Promise<boolean>
}

let cachedClient: BackupClient | null = null

function getClient(): BackupClient {
  if (cachedClient) return cachedClient
  const manager = getPluginBackupManager()
  cachedClient = {
    createBackup: (pluginId) => manager.createBackup(pluginId),
    restore: (backupId) => manager.restore(backupId),
    getBackups: (pluginId) => manager.getBackups(pluginId),
    deleteBackup: (backupId) => manager.deleteBackup(backupId),
  }
  return cachedClient
}

export function __resetPluginBackupClientForTests(client: BackupClient | null) {
  cachedClient = client
}

interface Props {
  pluginId: string
}

export function PluginBackupPanel({ pluginId }: Props) {
  const t = useTranslations("plugins.backup")
  const [snapshots, setSnapshots] = useState<PluginBackup[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tauri = isTauri()

  const refresh = () => {
    try {
      setSnapshots(getClient().getBackups(pluginId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId])

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await getClient().createBackup(pluginId)
      if (!result.success) {
        setError(result.error ?? t("createFailed"))
      }
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const restore = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await getClient().restore(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await getClient().deleteBackup(id)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <ArchiveIcon className="size-4" />
          {t("title")}
        </h3>
        <Button
          size="sm"
          onClick={() => void create()}
          disabled={busy || !tauri}
          aria-label={t("create")}
        >
          {busy ? t("creating") : t("create")}
        </Button>
      </div>

      {!tauri && <p className="text-xs text-muted-foreground">{t("desktopOnlyHint")}</p>}

      {error && <p className="text-xs text-destructive break-words">{error}</p>}

      <ScrollArea className="max-h-[40vh] sm:max-h-[30vh]">
        {snapshots.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">{t("empty")}</p>
        ) : (
          <ul className="space-y-1">
            {snapshots.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-2 text-xs border rounded-md px-2 py-1.5"
              >
                <Badge variant="outline" className="font-mono shrink-0">
                  {s.id.slice(0, 8)}
                </Badge>
                <Badge variant="secondary" className="text-xs shrink-0">
                  v{s.version}
                </Badge>
                <Badge variant="outline" className="text-xs shrink-0">
                  {s.reason}
                </Badge>
                <span className="text-muted-foreground flex-1 min-w-0 truncate">
                  {s.createdAt.toISOString()}
                  {s.size > 0 ? ` · ${(s.size / 1024).toFixed(1)} KB` : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void restore(s.id)}
                  disabled={busy || !tauri}
                  aria-label={t("restore")}
                >
                  <RotateCcwIcon className="size-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => void remove(s.id)}
                  disabled={busy || !tauri}
                  aria-label={t("delete")}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </Card>
  )
}
