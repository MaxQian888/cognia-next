"use client"

/**
 * Every harness an agent has had: captures, candidates, compositions,
 * adoptions and restores. Opening a version compares it with the agent's
 * harness today and offers to restore it; a restore is rated like an
 * adoption and needs the person's confirmation.
 */

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useAgentHarnessSnapshots } from "@/hooks/harness/use-harness-data"
import type { RestorePreview } from "@/lib/harness/runtime/restore"
import type { HarnessSnapshotV1 } from "@/types/harness/snapshot"
import { useStepLabel } from "./harness-run-timeline"
import { HarnessSnapshotDiff } from "./harness-snapshot-diff"

const RISK_VARIANT = { low: "success", medium: "warning", high: "destructive" } as const
const RESTORE_CODES = ["not-found", "other-agent", "unchanged", "agent-changed"] as const

export interface HarnessVersionHistoryProps {
  characterId: string
  /** The snapshot the agent's harness was last adopted or restored from. */
  adoptedSnapshotId?: string
  /** Whether the agent can be written here (built-in and plugin agents cannot). */
  editable: boolean
  onOpenRun?: (runId: string) => void
}

export function HarnessVersionHistory({
  characterId,
  adoptedSnapshotId,
  editable,
  onOpenRun,
}: HarnessVersionHistoryProps) {
  const t = useTranslations("harnessEvolution.versions")
  const format = useFormatter()
  const labelOf = useStepLabel()
  const snapshots = useAgentHarnessSnapshots(characterId)
  const [opened, setOpened] = useState<HarnessSnapshotV1 | null>(null)
  const [preview, setPreview] = useState<RestorePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState(false)

  const describe = (error: unknown) => {
    const code = (error as { code?: unknown })?.code
    if (
      (error as { name?: unknown })?.name === "HarnessRestoreError" &&
      RESTORE_CODES.includes(code as never)
    ) {
      return t(`errors.${code as (typeof RESTORE_CODES)[number]}`)
    }
    return error instanceof Error ? error.message : String(error)
  }

  const open = async (snapshot: HarnessSnapshotV1) => {
    setOpened(snapshot)
    setPreview(null)
    setLoading(true)
    try {
      const restore = await import("@/lib/harness/runtime/restore")
      setPreview(
        await restore.previewHarnessRestore(
          characterId,
          snapshot.id,
          await restore.defaultRestoreDeps()
        )
      )
    } catch (error) {
      toast.error(t("previewFailed"), { description: describe(error) })
      setOpened(null)
    } finally {
      setLoading(false)
    }
  }

  const restore = async () => {
    if (!opened || !preview) return
    setRestoring(true)
    try {
      const mod = await import("@/lib/harness/runtime/restore")
      await mod.restoreHarnessVersion(
        { characterId, snapshotId: opened.id, expectedContentHash: preview.current.contentHash },
        await mod.defaultRestoreDeps()
      )
      toast.success(t("restored"))
      setOpened(null)
    } catch (error) {
      toast.error(t("restoreFailed"), { description: describe(error) })
    } finally {
      setRestoring(false)
    }
  }

  if (snapshots.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="harness-versions-empty">
        {t("empty")}
      </p>
    )
  }
  return (
    <>
      <ul className="flex flex-col gap-1.5" data-testid="harness-version-history">
        {snapshots.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline">{t(`origin.${s.origin.kind}`)}</Badge>
                {s.origin.label ? <span className="text-sm">{labelOf(s.origin.label)}</span> : null}
                {s.id === adoptedSnapshotId ? (
                  <Badge variant="success">{t("inEffect")}</Badge>
                ) : null}
              </div>
              <span className="text-xs text-muted-foreground">
                {format.dateTime(s.createdAt, { dateStyle: "medium", timeStyle: "short" })}
                {" · "}
                <code>{s.contentHash.slice(0, 10)}</code>
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {s.origin.runId && onOpenRun ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onOpenRun(s.origin.runId as string)}
                >
                  {t("openRun")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void open(s)}
                data-testid={`harness-version-open-${s.id}`}
              >
                {t("compare")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <Dialog open={opened !== null} onOpenChange={(v) => !v && setOpened(null)}>
        <DialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
          data-testid="harness-version-dialog"
        >
          <DialogHeader>
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
            <DialogDescription>{t("dialogBody")}</DialogDescription>
          </DialogHeader>
          {loading || !preview ? (
            <p className="text-sm text-muted-foreground">{t("loading")}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {preview.unchanged ? (
                <p className="text-sm">{t("sameAsCurrent")}</p>
              ) : (
                <>
                  <div className="flex flex-col gap-1">
                    <Badge variant={RISK_VARIANT[preview.risk.risk]} className="w-fit">
                      {t(`risk.${preview.risk.risk}`)}
                    </Badge>
                    <ul className="list-disc pl-5 text-xs text-muted-foreground">
                      {preview.risk.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </div>
                  <HarnessSnapshotDiff
                    before={preview.current.components}
                    after={preview.target.components}
                  />
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpened(null)}>
              {t("close")}
            </Button>
            <Button
              disabled={!editable || !preview || preview.unchanged || restoring}
              onClick={() => void restore()}
              data-testid="harness-version-restore"
              title={editable ? undefined : t("notEditable")}
            >
              {t("restore")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
