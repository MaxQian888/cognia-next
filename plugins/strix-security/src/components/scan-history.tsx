"use client"

import { Loader2, Trash2 } from "lucide-react"
import { Badge } from "@cognia/plugin-ui"
import { Button } from "@cognia/plugin-ui"
import { cn } from "@cognia/plugin-ui"
import type { PluginI18nAPI } from "@cognia/plugin-sdk"
import type { RunStatus, StrixRun } from "../types"
import { runErrorText } from "../lib/run-error"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { PLUGIN_ID } from "../ids"

const STATUS_KEY: Record<RunStatus, string> = {
  running: "status.running",
  done: "status.done",
  error: "status.error",
  cancelled: "status.cancelled",
}

const STATUS_CLASS: Record<RunStatus, string> = {
  running: "border-info/50 text-info",
  done: "border-success/50 text-success",
  error: "border-destructive/50 text-destructive",
  cancelled: "",
}

/** `1m 05s`, `42s`, `3h 02m` — compact, locale-independent. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`
  return `${sec}s`
}

/** Month, day and time — in the APP's locale, via `ctx.i18n.formatDate`. */
const TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
}

/** 36px on touch-first narrow screens, compact from `sm` up. */
const TOUCH_BUTTON = "h-9 sm:h-8"
const TOUCH_ICON_BUTTON = "size-9 sm:size-8"

interface Props {
  runs: StrixRun[]
  /**
   * `ctx.i18n.formatDate`. The browser's `toLocaleString()` follows the OS
   * locale, which is not the language the user picked in the app.
   */
  formatDate: PluginI18nAPI["formatDate"]
  /** The run currently opened in the scan tab, if any. */
  selectedRunId?: string | null
  onView: (runId: string) => void
  onDelete: (runId: string) => void
  onClearAll: () => void
}

export function ScanHistory({
  runs,
  formatDate,
  selectedRunId,
  onView,
  onDelete,
  onClearAll,
}: Props) {
  const t = usePluginTranslations(PLUGIN_ID)

  if (runs.length === 0) {
    return (
      <div
        className="py-8 text-center text-sm text-muted-foreground"
        data-testid="strix-history-empty"
      >
        {t("history.empty")}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">
          {t("history.title")}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className={TOUCH_BUTTON}
          onClick={onClearAll}
          data-testid="strix-clear-all"
        >
          {t("history.clearAll")}
        </Button>
      </div>

      {runs.map((r) => {
        const selected = r.runId === selectedRunId
        const running = r.status === "running"
        return (
          <div
            key={r.runId}
            className={cn("rounded-md border p-2", selected && "border-primary/60 bg-accent/40")}
            data-testid="strix-history-row"
            data-selected={selected ? "true" : undefined}
          >
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                className="min-h-9 min-w-0 flex-1 text-left font-mono text-xs break-all focus-visible:underline focus-visible:outline-none sm:min-h-0 [@media(hover:hover)]:hover:underline"
                onClick={() => onView(r.runId)}
                data-testid="strix-history-target"
              >
                {r.target}
              </button>
              <Badge
                variant="outline"
                className={cn("shrink-0 gap-1", STATUS_CLASS[r.status])}
                data-testid="strix-history-status"
              >
                {running && (
                  <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
                )}
                {t(STATUS_KEY[r.status])}
              </Badge>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{formatDate(new Date(r.startedAt), TIMESTAMP_FORMAT)}</span>
              {r.endedAt != null && <span>· {formatDuration(r.endedAt - r.startedAt)}</span>}
              <span>· {t("history.findingsCount", { count: r.findingsCount })}</span>
            </div>
            {r.status === "error" && runErrorText(r, t) && (
              <p
                className="mt-1 text-xs break-words whitespace-pre-wrap text-destructive"
                data-testid="strix-history-error"
              >
                {runErrorText(r, t)}
              </p>
            )}
            <div className="mt-1 flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                className={TOUCH_BUTTON}
                onClick={() => onView(r.runId)}
                data-testid="strix-history-open"
              >
                {t("history.open")}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={TOUCH_ICON_BUTTON}
                onClick={() => onDelete(r.runId)}
                disabled={running}
                title={running ? t("history.deleteRunningDisabled") : t("history.delete")}
                aria-label={running ? t("history.deleteRunningDisabled") : t("history.delete")}
                data-testid="strix-history-delete"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
