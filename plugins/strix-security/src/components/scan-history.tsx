"use client"

import { Loader2, Trash2 } from "lucide-react"
import { Badge } from "@cognia/plugin-ui"
import { Button } from "@cognia/plugin-ui"
import { cn } from "@cognia/plugin-ui"
import type { RunStatus, StrixRun } from "../types"
import { usePluginT } from "../use-plugin-t"

const STATUS_KEY: Record<RunStatus, string> = {
  running: "status.running",
  done: "status.done",
  error: "status.error",
  cancelled: "status.cancelled",
}

const STATUS_CLASS: Record<RunStatus, string> = {
  running: "border-sky-500/50 text-sky-600 dark:text-sky-400",
  done: "border-emerald-500/50 text-emerald-600 dark:text-emerald-400",
  error: "border-red-500/50 text-red-600 dark:text-red-400",
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

function formatTimestamp(startedAt: number): string {
  const date = new Date(startedAt)
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

interface Props {
  runs: StrixRun[]
  /** The run currently opened in the scan tab, if any. */
  selectedRunId?: string | null
  onView: (runId: string) => void
  onDelete: (runId: string) => void
  onClearAll: () => void
}

export function ScanHistory({ runs, selectedRunId, onView, onDelete, onClearAll }: Props) {
  const t = usePluginT()

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
        <Button variant="ghost" size="sm" onClick={onClearAll} data-testid="strix-clear-all">
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
                className="min-w-0 flex-1 truncate text-left font-mono text-xs hover:underline"
                onClick={() => onView(r.runId)}
                title={r.target}
                data-testid="strix-history-target"
              >
                {r.target}
              </button>
              <Badge
                variant="outline"
                className={cn("shrink-0 gap-1", STATUS_CLASS[r.status])}
                data-testid="strix-history-status"
              >
                {running && <Loader2 className="size-3 animate-spin" />}
                {t(STATUS_KEY[r.status])}
              </Badge>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{formatTimestamp(r.startedAt)}</span>
              {r.endedAt != null && <span>· {formatDuration(r.endedAt - r.startedAt)}</span>}
              <span>· {t("history.findingsCount", { count: r.findingsCount })}</span>
            </div>
            {r.status === "error" && r.error && (
              <p
                className="mt-1 truncate text-xs text-red-600 dark:text-red-400"
                title={r.error}
                data-testid="strix-history-error"
              >
                {r.error}
              </p>
            )}
            <div className="mt-1 flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onView(r.runId)}
                data-testid="strix-history-open"
              >
                {t("history.open")}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onDelete(r.runId)}
                disabled={running}
                title={running ? t("history.deleteRunningDisabled") : t("history.delete")}
                aria-label={t("history.delete")}
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
