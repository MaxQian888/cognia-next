"use client"

/**
 * The answer to a summarize / explain / translate on text selected in the
 * transcript, shown beside the selection instead of spending a turn on it.
 *
 * Every way a run can end is said, never collapsed into an empty box: a result,
 * a stop (what streamed is kept), a refusal with its reason (no model here, the
 * PII gate, an empty answer) and a provider failure. A result can be copied or
 * referenced into the conversation, which is the point of producing it here.
 */

import { useTranslations } from "next-intl"
import {
  CheckIcon,
  CopyIcon,
  Loader2Icon,
  QuoteIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { useCopy } from "@/hooks/ui/use-copy"
import type { SelectionRunState } from "@/hooks/chat/use-selection-action-run"
import { selectionTitleFor } from "@/lib/chat/selection/selection-text"
import { loggers } from "@cognia/logging"

type ActiveRun = Exclude<SelectionRunState, { status: "idle" }>

export interface MessageSelectionResultPanelProps {
  run: ActiveRun
  /** The translation target, localized, for the title. */
  languageLabel?: string
  /**
   * The line naming what the run was made from, when that is not a text
   * selection — "From 3 selected messages". Defaults to quoting the selection's
   * opening words, which a count must not be dressed up as.
   */
  sourceLabel?: string
  /** Overrides the popover sizing, for a host that is not a popover (a phone sheet). */
  className?: string
  onStop: () => void
  onRetry: () => void
  onClose: () => void
  onReference: (text: string) => void
  /** A reference is being staged; the button waits for it. */
  referencing?: boolean
}

const UNAVAILABLE_KEYS = {
  empty: "empty",
  "no-client": "noClient",
  pii: "pii",
  "no-output": "noOutput",
} as const

function textOf(run: ActiveRun): string {
  return run.status === "unavailable" ? "" : run.text
}

export function MessageSelectionResultPanel({
  run,
  languageLabel,
  sourceLabel,
  className,
  onStop,
  onRetry,
  onClose,
  onReference,
  referencing = false,
}: MessageSelectionResultPanelProps) {
  const t = useTranslations("chat.selection.result")
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })
  const text = textOf(run)
  const running = run.status === "running"
  const { action } = run.request
  const title =
    action === "translate"
      ? t("title.translate", { language: languageLabel ?? run.request.targetLocale ?? "" })
      : t(`title.${action}`)
  // Only a finished or stopped run has text worth keeping; a failure's partial
  // text is shown so nothing vanishes, but it is not offered as a result.
  const usable = Boolean(text.trim()) && (run.status === "done" || run.status === "stopped")

  return (
    <section
      data-testid="message-selection-result"
      data-status={run.status}
      aria-busy={running}
      className={cn("flex max-h-[min(60vh,480px)] w-[min(92vw,440px)] flex-col gap-2", className)}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {sourceLabel ?? t("source", { title: selectionTitleFor(run.request.quote) })}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0"
          aria-label={t("close")}
          onClick={onClose}
          data-testid="message-selection-result-close"
        >
          <XIcon className="size-3.5" />
        </Button>
      </header>

      <div className="min-h-0 overflow-auto text-sm" data-testid="message-selection-result-body">
        {text ? (
          <MarkdownRenderer content={text} isStreaming={running} />
        ) : running ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
            {t("working")}
          </p>
        ) : null}
      </div>

      {running && run.progress && run.progress.total > 1 ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="message-selection-result-progress"
        >
          {run.progress.combining
            ? t("combining", { total: run.progress.total - 1 })
            : t("part", {
                done: Math.min(run.progress.done + 1, run.progress.total),
                total: run.progress.total,
              })}
        </p>
      ) : null}
      {run.status === "stopped" ? (
        <p className="text-[11px] text-muted-foreground">{t("stopped")}</p>
      ) : null}
      {run.status === "unavailable" ? (
        <p role="alert" className="text-xs text-muted-foreground">
          {t(`unavailable.${UNAVAILABLE_KEYS[run.reason]}`)}
        </p>
      ) : null}
      {run.status === "failed" ? (
        <p role="alert" className="text-xs text-destructive">
          {t("failed", { reason: run.message })}
        </p>
      ) : null}

      <footer className="flex flex-wrap items-center justify-end gap-1.5">
        {running ? (
          <Button type="button" size="sm" variant="outline" onClick={onStop}>
            <SquareIcon className="size-3" />
            {t("stop")}
          </Button>
        ) : (
          <>
            {run.status !== "done" ? (
              <Button type="button" size="sm" variant="ghost" onClick={onRetry}>
                <RotateCcwIcon className="size-3.5" />
                {t("retry")}
              </Button>
            ) : null}
            {usable ? (
              <>
                <Button type="button" size="sm" variant="outline" onClick={() => void copy(text)}>
                  {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                  {copied ? t("copied") : t("copy")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onReference(text)}
                  disabled={referencing}
                  data-testid="message-selection-result-reference"
                >
                  <QuoteIcon className="size-3.5" />
                  {t("reference")}
                </Button>
              </>
            ) : null}
          </>
        )}
      </footer>
    </section>
  )
}
