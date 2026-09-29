"use client"

/**
 * The desktop browser's download manager (ADR-0201): progress, cancel, save
 * as (local Chromium / user Chrome, native save dialog), open, reveal in
 * folder, download again, remove from list, clear, and attach to chat. Rows come from Dexie `browserDownloads`, which every backend's feed
 * writes (`useBrowserDownloadFeed`, mounted app-wide by `BrowserDownloadsInitializer`).
 */

import {
  DownloadIcon,
  FileIcon,
  FolderOpenIcon,
  PaperclipIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  downloadCapabilities,
  useBrowserDownloadActions,
  useBrowserDownloads,
  type BrowserDownloadActions,
  type DownloadActionOutcome,
} from "@/hooks/browser/use-browser-downloads"
import type { BrowserDownloadRow } from "@/lib/db/browser-downloads"
import { formatBytes } from "@/lib/storage/usage"
import { cn } from "@/lib/utils"

function progressPercent(row: BrowserDownloadRow): number | null {
  if (!row.totalBytes || row.totalBytes <= 0) return null
  return Math.min(100, Math.round(((row.receivedBytes ?? 0) / row.totalBytes) * 100))
}

export interface BrowserDownloadsPanelProps {
  downloads: BrowserDownloadRow[]
  actions: BrowserDownloadActions
  /** Re-request a failed / cancelled download in the pane's current engine. */
  onRetry?: (url: string) => void
}

export function BrowserDownloadsPanel({ downloads, actions, onRetry }: BrowserDownloadsPanelProps) {
  const t = useTranslations("browserLocal.downloads")

  const report = (outcome: DownloadActionOutcome, failure: string, success?: string) => {
    if (outcome === "ok") {
      if (success) toast.success(success)
    } else if (outcome === "cancelled") {
      // The user dismissed a native dialog: nothing to report.
    } else if (outcome === "no-session") {
      toast.error(t("noSession"))
    } else if (outcome === "too-large") {
      toast.error(t("tooLarge"))
    } else {
      toast.error(failure)
    }
  }

  return (
    <div className="flex max-h-[28rem] w-80 flex-col" data-testid="browser-downloads-panel">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <p className="text-sm font-medium">{t("title")}</p>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          disabled={!downloads.some((row) => row.state !== "in_progress")}
          onClick={() => void actions.clear().then((outcome) => report(outcome, t("clearFailed")))}
        >
          {t("clear")}
        </Button>
      </div>
      {downloads.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="divide-y">
            {downloads.map((row) => {
              const can = downloadCapabilities(row)
              const percent = progressPercent(row)
              const received = formatBytes(row.receivedBytes ?? row.size)
              return (
                <li key={row.id} className="space-y-1.5 px-3 py-2" data-testid="browser-download">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <p className="min-w-0 flex-1 truncate text-xs font-medium" title={row.filename}>
                      {row.filename || row.url || row.downloadId}
                    </p>
                    <Badge
                      variant={row.state === "failed" ? "destructive" : "outline"}
                      className="shrink-0 text-[10px]"
                    >
                      {t(`state.${row.state}`)}
                    </Badge>
                  </div>
                  {row.state === "in_progress" && (
                    <div className="space-y-1">
                      {percent !== null && (
                        <Progress value={percent} className="h-1" aria-label={row.filename} />
                      )}
                      <p className="text-[11px] text-muted-foreground">
                        {row.totalBytes
                          ? t("progress", { received, total: formatBytes(row.totalBytes) })
                          : t("progressUnknown", { received })}
                      </p>
                    </div>
                  )}
                  {row.state !== "in_progress" && row.size > 0 && (
                    <p className="text-[11px] text-muted-foreground">{formatBytes(row.size)}</p>
                  )}
                  {row.error && (
                    <p className="break-words text-[11px] text-destructive">
                      {t("failedDetail", { message: row.error })}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-0.5">
                    {can.cancel && (
                      <TooltipIconButton
                        tooltip={t("cancel")}
                        aria-label={t("cancel")}
                        size="icon-xs"
                        onClick={() =>
                          void actions
                            .cancel(row)
                            .then((outcome) => report(outcome, t("cancelFailed")))
                        }
                      >
                        <XIcon />
                      </TooltipIconButton>
                    )}
                    {can.saveAs && (
                      <TooltipIconButton
                        tooltip={t("saveAs")}
                        aria-label={t("saveAs")}
                        size="icon-xs"
                        onClick={() =>
                          void actions
                            .saveAs(row)
                            .then((outcome) => report(outcome, t("saveAsFailed")))
                        }
                      >
                        <SaveIcon />
                      </TooltipIconButton>
                    )}
                    {can.open && (
                      <TooltipIconButton
                        tooltip={t("open")}
                        aria-label={t("open")}
                        size="icon-xs"
                        onClick={() =>
                          void actions.open(row).then((outcome) => {
                            if (outcome !== "blocked") {
                              report(outcome, t("openFailed"))
                              return
                            }
                            // Only safe document/media/archive types open
                            // from here; offer the folder instead.
                            toast.error(t("openBlocked"), {
                              action: {
                                label: t("reveal"),
                                onClick: () =>
                                  void actions
                                    .reveal(row)
                                    .then((next) => report(next, t("revealFailed"))),
                              },
                            })
                          })
                        }
                      >
                        <FileIcon />
                      </TooltipIconButton>
                    )}
                    {can.reveal && (
                      <TooltipIconButton
                        tooltip={t("reveal")}
                        aria-label={t("reveal")}
                        size="icon-xs"
                        onClick={() =>
                          void actions
                            .reveal(row)
                            .then((outcome) => report(outcome, t("revealFailed")))
                        }
                      >
                        <FolderOpenIcon />
                      </TooltipIconButton>
                    )}
                    {can.attach && (
                      <TooltipIconButton
                        tooltip={t("attach")}
                        aria-label={t("attach")}
                        size="icon-xs"
                        onClick={() =>
                          void actions
                            .attach(row)
                            .then((outcome) => report(outcome, t("attachFailed"), t("attached")))
                        }
                      >
                        <PaperclipIcon />
                      </TooltipIconButton>
                    )}
                    {can.retry && onRetry && row.url && (
                      <TooltipIconButton
                        tooltip={t("retry")}
                        aria-label={t("retry")}
                        size="icon-xs"
                        onClick={() => onRetry(row.url as string)}
                      >
                        <RotateCcwIcon />
                      </TooltipIconButton>
                    )}
                    {can.remove && (
                      <TooltipIconButton
                        tooltip={t("remove")}
                        aria-label={t("remove")}
                        size="icon-xs"
                        className="ml-auto"
                        onClick={() =>
                          void actions
                            .remove(row)
                            .then((outcome) => report(outcome, t("removeFailed")))
                        }
                      >
                        <Trash2Icon />
                      </TooltipIconButton>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      )}
    </div>
  )
}

/**
 * The toolbar entry: a Downloads button whose badge counts running downloads,
 * opening the panel in a popover.
 */
export function BrowserDownloadsButton({
  chatSessionId,
  onRetry,
}: {
  chatSessionId?: string
  onRetry?: (url: string) => void
}) {
  const t = useTranslations("browserLocal.downloads")
  const { downloads, activeCount } = useBrowserDownloads()
  const actions = useBrowserDownloadActions(chatSessionId)
  const label = activeCount > 0 ? t("buttonActive", { count: activeCount }) : t("button")
  return (
    <Popover>
      <PopoverTrigger asChild>
        <TooltipIconButton
          tooltip={label}
          aria-label={label}
          className={cn("relative", activeCount > 0 && "text-primary")}
        >
          <DownloadIcon />
          {activeCount > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground"
              aria-hidden
              data-testid="browser-downloads-badge"
            >
              {activeCount > 9 ? "9+" : activeCount}
            </span>
          )}
        </TooltipIconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <BrowserDownloadsPanel downloads={downloads} actions={actions} onRetry={onRetry} />
      </PopoverContent>
    </Popover>
  )
}
