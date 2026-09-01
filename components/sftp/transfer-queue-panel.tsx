"use client"

/**
 * The transfer queue, shared by every shell (ADR-0162).
 *
 * One component for the desktop, the browser and the phone, because a transfer
 * looks the same everywhere and the only thing that differs is how much room it
 * has. Termius and Cyberduck both landed on the same answer: a browser and a
 * separate list of transfers, rather than a fixed two-pane layout that has
 * nowhere to go on a narrow screen.
 *
 * The rows come from Dexie, not from React state. A transfer that only existed
 * inside this component would vanish when it unmounted, which is the failure
 * the durable queue exists to prevent.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon, PauseIcon, PlayIcon, RotateCcwIcon, SaveIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Surface } from "@/components/surface/surface"
import { downloadBlob } from "@/lib/files/download"
import {
  cancelSftpTransfer,
  clearFinishedSftpTransfers,
  isSftpTransferFinished,
  observeSftpTransfers,
  pauseSftpTransfer,
  resumeSftpTransfer,
  retrySftpTransfer,
  SFTP_APPROVAL_REQUIRED,
  setSftpTransferApproval,
  type SftpTransferRow,
} from "@/lib/sftp/transfer-queue"
import { requestSftpTransferApproval } from "@/lib/sftp/client"
import { cn } from "@/lib/utils"

export interface TransferQueuePanelProps {
  /** Narrow the list to one machine. Omit to show every transfer. */
  profileId?: string
  className?: string
}

function percentOf(row: SftpTransferRow): number {
  if (row.size <= 0) return row.status === "done" ? 100 : 0
  return Math.min(100, Math.round((row.transferred / row.size) * 100))
}

export function TransferQueuePanel({ profileId, className }: TransferQueuePanelProps) {
  const t = useTranslations("sftp.queue")
  const [rows, setRows] = useState<SftpTransferRow[]>([])
  const [approving, setApproving] = useState(false)

  useEffect(() => {
    const subscription = observeSftpTransfers(profileId).subscribe({
      next: setRows,
      // A dead subscription must not blank the list: the rows on screen are the
      // last true answer, and showing an empty queue would read as "nothing is
      // transferring" when the truth is "we stopped being told".
      error: () => undefined,
    })
    return () => subscription.unsubscribe()
  }, [profileId])

  const approve = useCallback(async () => {
    setApproving(true)
    try {
      const token = await requestSftpTransferApproval()
      setSftpTransferApproval(token)
      // Every parked row goes back to the queue. The approval covers the
      // profile and direction, not one file, so approving once and then having
      // to press resume on each row would be ceremony without a decision.
      await Promise.all(
        rows
          .filter((row) => row.errorCode === SFTP_APPROVAL_REQUIRED)
          .map((row) => resumeSftpTransfer(row.id))
      )
    } finally {
      setApproving(false)
    }
  }, [rows])

  const save = useCallback((row: SftpTransferRow) => {
    if (!row.received) return
    // `Uint8Array` on the way out of Dexie, a `Blob` on the way into the
    // browser's save. The row holds bytes because that is what survives a
    // structured clone.
    downloadBlob(new Blob([row.received]), row.fileName)
  }, [])

  const needsApproval = rows.some((row) => row.errorCode === SFTP_APPROVAL_REQUIRED)
  const finished = rows.filter((row) => isSftpTransferFinished(row.status)).length

  if (rows.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)} data-testid="sftp-queue-empty">
        {t("empty")}
      </p>
    )
  }

  return (
    <div className={cn("space-y-3", className)} data-testid="sftp-queue">
      {needsApproval ? (
        <Surface
          layer="sunken"
          radius="control"
          className="flex flex-wrap items-center gap-2 border p-2.5"
        >
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("approvalNeeded")}</p>
          <Button size="sm" onClick={() => void approve()} disabled={approving}>
            {t("approve")}
          </Button>
        </Surface>
      ) : null}

      <ul className="space-y-2">
        {rows.map((row) => (
          <Surface
            asChild
            radius="control"
            key={row.id}
            className="border p-2.5"
            data-testid={`sftp-transfer-${row.id}`}
            data-status={row.status}
          >
            <li>
              <div className="flex items-center gap-2">
                <DownloadIcon
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground",
                    row.direction === "upload" && "rotate-180"
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.fileName}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {t(`status.${row.status}`)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {row.profileLabel} {row.remotePath}
              </p>

              {row.status === "running" || row.status === "paused" ? (
                <Progress value={percentOf(row)} className="mt-2 h-1" />
              ) : null}

              {/*
              The machine's own words. An SFTP server answers "Permission
              denied" or "No space left on device", and paraphrasing that into
              a generic failure throws away the only part a person can act on.
            */}
              {row.errorMessage && row.errorCode !== SFTP_APPROVAL_REQUIRED ? (
                <p
                  className="mt-1.5 text-[11px] text-destructive"
                  data-testid={`sftp-transfer-error-${row.id}`}
                >
                  {row.errorMessage}
                </p>
              ) : null}

              <div className="mt-2 flex flex-wrap gap-1.5">
                {row.status === "running" ? (
                  <Button size="sm" variant="ghost" onClick={() => void pauseSftpTransfer(row.id)}>
                    <PauseIcon className="size-3.5" aria-hidden />
                    {t("pause")}
                  </Button>
                ) : null}
                {row.status === "paused" && row.errorCode !== SFTP_APPROVAL_REQUIRED ? (
                  <Button size="sm" variant="ghost" onClick={() => void resumeSftpTransfer(row.id)}>
                    <PlayIcon className="size-3.5" aria-hidden />
                    {t("resume")}
                  </Button>
                ) : null}
                {row.status === "failed" ? (
                  <Button size="sm" variant="ghost" onClick={() => void retrySftpTransfer(row.id)}>
                    <RotateCcwIcon className="size-3.5" aria-hidden />
                    {t("retry")}
                  </Button>
                ) : null}
                {row.status === "done" && row.direction === "download" && row.received ? (
                  <Button size="sm" variant="ghost" onClick={() => save(row)}>
                    <SaveIcon className="size-3.5" aria-hidden />
                    {t("save")}
                  </Button>
                ) : null}
                {!isSftpTransferFinished(row.status) ? (
                  <Button size="sm" variant="ghost" onClick={() => void cancelSftpTransfer(row.id)}>
                    <XIcon className="size-3.5" aria-hidden />
                    {t("cancel")}
                  </Button>
                ) : null}
              </div>
            </li>
          </Surface>
        ))}
      </ul>

      {finished > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void clearFinishedSftpTransfers(profileId)}
          data-testid="sftp-queue-clear"
        >
          {t("clearFinished", { count: finished })}
        </Button>
      ) : null}
    </div>
  )
}
