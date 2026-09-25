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
//
// Restore overwrites the plugin's current state and delete is permanent, so
// both ask first (they fired on a single tap). The list is derived from the
// backup index at render, keyed on the index revision: the persisted index is
// loaded once per page (`usePluginBackupIndexRevision`), and every write here
// bumps it so the Library's Rollback menu items re-check as well. Dates and
// sizes are formatted for the user's locale.

import { useMemo, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { ArchiveIcon, Trash2Icon, RotateCcwIcon } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  notifyPluginBackupsChanged,
  usePluginBackupIndexRevision,
} from "@/hooks/plugins/use-plugin-rollback-availability"
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

type PendingAction = { kind: "restore" | "delete"; backup: PluginBackup }

export function PluginBackupPanel({ pluginId }: Props) {
  const t = useTranslations("plugins.backup")
  const format = useFormatter()
  const indexRevision = usePluginBackupIndexRevision()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const tauri = isTauri()

  const listing = useMemo(() => {
    try {
      return { snapshots: getClient().getBackups(pluginId), readError: null as string | null }
    } catch (err) {
      return {
        snapshots: [] as PluginBackup[],
        readError: err instanceof Error ? err.message : String(err),
      }
    }
    // `indexRevision` is the change signal for the backup index.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId, indexRevision])
  const snapshots = listing.snapshots
  const shownError = error ?? listing.readError

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true)
    setError(null)
    try {
      const failure = await work()
      if (failure) setError(failure)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      notifyPluginBackupsChanged()
      setBusy(false)
    }
  }

  const create = () =>
    run(async () => {
      const result = await getClient().createBackup(pluginId)
      return result.success ? null : (result.error ?? t("createFailed"))
    })

  const confirmPending = () => {
    const action = pending
    setPending(null)
    if (!action) return
    void run(async () => {
      if (action.kind === "restore") await getClient().restore(action.backup.id)
      else await getClient().deleteBackup(action.backup.id)
      return null
    })
  }

  const backupLabel = (backup: PluginBackup) => ({
    version: backup.version,
    date: format.dateTime(backup.createdAt, { dateStyle: "medium", timeStyle: "short" }),
  })

  return (
    <Card className="p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <ArchiveIcon className="size-4" aria-hidden="true" />
          {t("title")}
        </h3>
        <Button
          size="sm"
          className="pointer-coarse:h-9"
          onClick={() => void create()}
          disabled={busy || !tauri}
          aria-label={t("create")}
        >
          {busy ? t("creating") : t("create")}
        </Button>
      </div>

      {!tauri && <p className="text-xs text-muted-foreground">{t("desktopOnlyHint")}</p>}

      {shownError && (
        <p className="text-xs text-destructive break-words" role="alert">
          {shownError}
        </p>
      )}

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
                  {t(`reason.${s.reason}` as never)}
                </Badge>
                <span className="text-muted-foreground flex-1 min-w-0 truncate">
                  <time dateTime={s.createdAt.toISOString()}>
                    {format.dateTime(s.createdAt, { dateStyle: "medium", timeStyle: "short" })}
                  </time>
                  {s.size > 0
                    ? ` · ${format.number(s.size / 1024, {
                        style: "unit",
                        unit: "kilobyte",
                        maximumFractionDigits: 1,
                      })}`
                    : ""}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 pointer-coarse:size-9"
                  onClick={() => setPending({ kind: "restore", backup: s })}
                  disabled={busy || !tauri}
                  aria-label={t("restoreAria", backupLabel(s))}
                >
                  <RotateCcwIcon className="size-3" aria-hidden="true" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-destructive pointer-coarse:size-9"
                  onClick={() => setPending({ kind: "delete", backup: s })}
                  disabled={busy || !tauri}
                  aria-label={t("deleteAria", backupLabel(s))}
                >
                  <Trash2Icon className="size-3" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === "delete" ? t("deleteConfirmTitle") : t("restoreConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending
                ? t(
                    pending.kind === "delete" ? "deleteConfirmBody" : "restoreConfirmBody",
                    backupLabel(pending.backup)
                  )
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant={pending?.kind === "delete" ? "destructive" : "default"}
              onClick={confirmPending}
            >
              {pending?.kind === "delete" ? t("delete") : t("restore")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
