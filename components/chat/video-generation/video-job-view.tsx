"use client"

/**
 * The live card of one video job (ADR-0205), shared by the `/video` system
 * block and the `video_generate` tool result. It reads the job's row, so once
 * the card is in the transcript it follows the job across reloads with no
 * further message writes: generating (elapsed time, cancel), then the video,
 * or a coded failure with "check again" (a job that may still be fine
 * remotely) and "try again" (a new job, whose card is posted the same way).
 */

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { ClapperboardIcon, ImageIcon, RefreshCwIcon, RotateCcwIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { VideoBlock } from "@/components/chat/renderers/video-block"
import { useNowTicker } from "@/hooks/fleet/use-now-ticker"
import { useVideoJobUrl } from "@/hooks/chat/use-video-job-url"
import { getProviderDisplayName } from "@/lib/ai/icons"
import { supportsRemoteVideoCancel } from "@/lib/ai/media/video-jobs/cancel"
import { getVideoJobEngine } from "@/lib/ai/media/video-jobs/host"
import { ensureRendererVideoJobHost } from "@/lib/ai/media/video-jobs/renderer-host"
import { retryInputOf } from "@/lib/ai/media/video-jobs/retry"
import {
  canRecheckVideoJob,
  type MediaGenerationJobRow,
  type VideoJobErrorCode,
} from "@/lib/ai/media/video-jobs/types"
import { getDb } from "@/lib/db/schema"
import { postVideoJobCard } from "@/lib/chat/video-job-card"
import { cn, formatVideoTime } from "@/lib/utils"
import { loggers } from "@cognia/logging"

/** Every failure code has a localized line; the provider's text is shown under it. */
export const VIDEO_JOB_ERROR_KEYS: Record<VideoJobErrorCode, string> = {
  pii_blocked: "errors.piiBlocked",
  no_provider: "errors.noProvider",
  credential_changed: "errors.credentialChanged",
  unsupported_input: "errors.unsupportedInput",
  unavailable_on_web: "errors.unavailableOnWeb",
  generation_failed: "errors.generationFailed",
  provider_error: "errors.providerError",
  timed_out: "errors.timedOut",
  download_failed: "errors.downloadFailed",
  result_too_large: "errors.resultTooLarge",
  result_expired: "errors.resultExpired",
  store_failed: "errors.storeFailed",
}

/**
 * Codes whose message carries the provider's (or the option's) own detail. For
 * the rest the localized line says it all, and the engine's English message
 * would only repeat it in the wrong language.
 */
const DETAIL_CODES: ReadonlySet<VideoJobErrorCode> = new Set([
  "unsupported_input",
  "generation_failed",
  "provider_error",
  "download_failed",
  "store_failed",
])

export function videoJobErrorDetail(error: { code: string; message?: string }): string | null {
  return DETAIL_CODES.has(error.code as VideoJobErrorCode) && error.message ? error.message : null
}

function engine() {
  ensureRendererVideoJobHost()
  return getVideoJobEngine()
}

export function VideoJobView({ jobId }: { jobId: string }) {
  const row = useLiveQuery(() => getDb().mediaGenerationJobs.get(jobId), [jobId], null)
  // `null` is the live query's loading value; `undefined` is a job that is gone.
  if (row === null) return null
  return <VideoJobCard jobId={jobId} row={row} />
}

export function VideoJobCard({
  jobId,
  row,
}: {
  jobId: string
  row: MediaGenerationJobRow | undefined
}) {
  const t = useTranslations("chat.videoGeneration")
  const [busy, setBusy] = useState<null | "cancel" | "recheck" | "retry">(null)
  const [actionError, setActionError] = useState<string | null>(null)

  if (!row) {
    return (
      <div data-testid="video-job-card" className="my-1 text-xs text-muted-foreground">
        {t("missingJob")}
      </div>
    )
  }

  const run = async (kind: "cancel" | "recheck" | "retry", action: () => Promise<void>) => {
    setBusy(kind)
    setActionError(null)
    try {
      await action()
    } catch (error) {
      loggers.media.warn("video job action failed", { jobId, action: kind, error: String(error) })
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const provider = getProviderDisplayName(row.provider.providerId)
  const running = row.status === "generating" || row.status === "downloading"
  const retryInput = retryInputOf(row)
  const sessionId = row.sessionId

  const onRetry = () =>
    run("retry", async () => {
      if (!retryInput || !sessionId) return
      const started = await engine().start(retryInput)
      if (!started.ok) {
        setActionError(
          t("retryFailed", { error: t(VIDEO_JOB_ERROR_KEYS[started.error.code] as never) })
        )
        return
      }
      await postVideoJobCard(sessionId, started.job.id)
    })

  return (
    <div
      data-testid="video-job-card"
      data-status={row.status}
      className="my-1 space-y-2 rounded-md border bg-muted/20 p-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <ClapperboardIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{t(`status.${statusKey(row.status)}` as never)}</span>
        </span>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {t("providerModel", { provider, model: row.provider.modelId })}
        </Badge>
      </div>

      <p className="line-clamp-2 text-muted-foreground" title={row.request.prompt}>
        {row.request.prompt}
      </p>
      {row.request.startFrame && (
        <p className="flex items-center gap-1 text-muted-foreground">
          <ImageIcon className="size-3" aria-hidden />
          {t("startFrame")}
        </p>
      )}

      {running && (
        <RunningRow row={row} busy={busy} onCancel={() => run("cancel", cancelJob(jobId))} />
      )}

      {row.status === "succeeded" && <FinishedVideo row={row} />}

      {row.status === "cancelled" && (
        <p className="text-muted-foreground" data-testid="video-job-cancelled">
          {row.remoteCancelled ? t("cancelledRemote") : t("cancelledLocal")}
        </p>
      )}

      {(row.status === "failed" || row.status === "timed_out") && row.error && (
        <div className="space-y-1" role="alert">
          <p className="font-medium text-destructive">
            {t(VIDEO_JOB_ERROR_KEYS[row.error.code] as never)}
          </p>
          {videoJobErrorDetail(row.error) && (
            <p className="break-words text-muted-foreground">{videoJobErrorDetail(row.error)}</p>
          )}
        </div>
      )}

      {(canRecheckVideoJob(row) || retryInput) && (
        <div className="flex flex-wrap gap-2">
          {canRecheckVideoJob(row) && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                run("recheck", async () => {
                  await engine().recheck(jobId)
                })
              }
            >
              <RefreshCwIcon className={cn("size-3", busy === "recheck" && "animate-spin")} />
              {t("checkAgain")}
            </Button>
          )}
          {retryInput && sessionId && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void onRetry()}
            >
              <RotateCcwIcon className="size-3" />
              {t("tryAgain")}
            </Button>
          )}
        </div>
      )}

      {actionError && <p className="text-destructive">{actionError}</p>}
    </div>
  )
}

function statusKey(status: MediaGenerationJobRow["status"]): string {
  return status === "timed_out" ? "timedOut" : status
}

function cancelJob(jobId: string) {
  return async () => {
    await engine().cancel(jobId)
  }
}

function RunningRow({
  row,
  busy,
  onCancel,
}: {
  row: MediaGenerationJobRow
  busy: string | null
  onCancel: () => void
}) {
  const t = useTranslations("chat.videoGeneration")
  const now = useNowTicker()
  const elapsed = formatVideoTime(Math.max(0, (now - row.createdAt) / 1000))
  const remoteCancel = supportsRemoteVideoCancel(row.provider.providerId)
  const provider = getProviderDisplayName(row.provider.providerId)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 tabular-nums text-muted-foreground">
          <Spinner className="size-3" />
          {t("elapsed", { elapsed })}
        </span>
        {row.status === "generating" && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy !== null}
            onClick={onCancel}
            aria-label={remoteCancel ? t("cancel") : t("stopWaiting")}
          >
            <XIcon className="size-3" />
            {remoteCancel ? t("cancel") : t("stopWaiting")}
          </Button>
        )}
      </div>
      {row.status === "generating" && !remoteCancel && (
        <p className="text-muted-foreground">{t("stopWaitingHint", { provider })}</p>
      )}
      {row.lastPollError && (
        <p className="text-muted-foreground">{t("lastPollError", { error: row.lastPollError })}</p>
      )}
    </div>
  )
}

function FinishedVideo({ row }: { row: MediaGenerationJobRow }) {
  const t = useTranslations("chat.videoGeneration")
  const video = useVideoJobUrl(row.result?.content)
  if (video.status === "missing") {
    return <p className="text-muted-foreground">{t("missingVideo")}</p>
  }
  if (video.status !== "ready") {
    return (
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Spinner className="size-3" />
        {t("loadingVideo")}
      </div>
    )
  }
  return <VideoBlock src={video.url} title={row.request.prompt} />
}
