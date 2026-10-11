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
// Flat: the Data tab owns the section heading and hairline, so the panel is a
// count + action row over a divided list, with no card or nested scroller.
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

/** Local date + time to the minute. */
const BACKUP_DATE_FORMAT = { dateStyle: "medium", timeStyle: "short" } as const

/**
 * Rows shown before "Show all". The detail pane is the scroller, so a long
 * history is capped here instead of getting a nested scroll area.
 */
export const BACKUP_ROW_LIMIT = 5

export function PluginBackupPanel({ pluginId }: Props) {
  const t = useTranslations("plugins.backup")
  const format = useFormatter()
  const indexRevision = usePluginBackupIndexRevision()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [showAll, setShowAll] = useState(false)
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

  const formatDate = (at: Date) => format.dateTime(at, BACKUP_DATE_FORMAT)
  const formatSize = (bytes: number) =>
    format.number(bytes / 1024, { style: "unit", unit: "kilobyte", maximumFractionDigits: 1 })

  const backupLabel = (backup: PluginBackup) => ({
    version: backup.version,
    date: formatDate(backup.createdAt),
  })

  const visible = showAll ? snapshots : snapshots.slice(0, BACKUP_ROW_LIMIT)

  return (
    <div className="@container space-y-2" data-testid="plugin-backup-panel">
      {/* The Data tab draws the "Backup" heading; this row is the panel's own
          state and its one primary action. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("count", { count: snapshots.length })}</p>
        <Button
          size="sm"
          variant="outline"
          className="pointer-coarse:h-10"
          onClick={() => void create()}
          disabled={busy || !tauri}
          aria-label={t("create")}
        >
          <ArchiveIcon className="size-3.5" aria-hidden="true" />
          {busy ? t("creating") : t("create")}
        </Button>
      </div>

      {!tauri && <p className="text-xs text-muted-foreground">{t("desktopOnlyHint")}</p>}

      {shownError && (
        <p
          className="border-l-2 border-destructive pl-2 text-xs text-destructive break-words"
          role="alert"
        >
          {shownError}
        </p>
      )}

      {/* With no snapshots the count line above already says "No backups";
          a second empty-state line under it repeated the same words. */}
      {snapshots.length === 0 ? null : (
        <>
          <ul className="divide-y" aria-label={t("title")}>
            {visible.map((s) => (
              <li key={s.id} className="flex items-center gap-2 py-1.5 text-xs">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-medium">{t("versionLabel", { version: s.version })}</span>
                    <span className="text-muted-foreground">
                      {t(`reason.${s.reason}` as never)}
                    </span>
                    <code className="font-mono text-[11px] text-muted-foreground">
                      {s.id.slice(0, 8)}
                    </code>
                  </p>
                  <p className="truncate text-muted-foreground">
                    {s.size > 0 ? (
                      t.rich("rowDetail", {
                        date: formatDate(s.createdAt),
                        size: formatSize(s.size),
                        time: (chunks) => (
                          <time dateTime={s.createdAt.toISOString()}>{chunks}</time>
                        ),
                      })
                    ) : (
                      <time dateTime={s.createdAt.toISOString()}>{formatDate(s.createdAt)}</time>
                    )}
                  </p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 pointer-coarse:size-10"
                  onClick={() => setPending({ kind: "restore", backup: s })}
                  disabled={busy || !tauri}
                  aria-label={t("restoreAria", backupLabel(s))}
                >
                  <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 text-destructive pointer-coarse:size-10"
                  onClick={() => setPending({ kind: "delete", backup: s })}
                  disabled={busy || !tauri}
                  aria-label={t("deleteAria", backupLabel(s))}
                >
                  <Trash2Icon className="size-3.5" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
          {snapshots.length > BACKUP_ROW_LIMIT && (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 h-7 text-xs text-muted-foreground pointer-coarse:h-10"
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
            >
              {showAll ? t("showLess") : t("showAll", { count: snapshots.length })}
            </Button>
          )}
        </>
      )}

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
    </div>
  )
}
