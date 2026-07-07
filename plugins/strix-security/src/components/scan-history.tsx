"use client"

import { Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { RunStatus, StrixRun } from "../types"
import { usePluginT } from "../use-plugin-t"

const STATUS_KEY: Record<RunStatus, string> = {
  running: "status.running",
  done: "status.done",
  error: "status.error",
  cancelled: "status.cancelled",
}

interface Props {
  runs: StrixRun[]
  onView: (runId: string) => void
  onDelete: (runId: string) => void
  onClearAll: () => void
}

export function ScanHistory({ runs, onView, onDelete, onClearAll }: Props) {
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

      {runs.map((r) => (
        <div key={r.runId} className="rounded-md border p-2" data-testid="strix-history-row">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-xs">{r.target}</span>
            <Badge variant="outline" className="shrink-0">
              {t(STATUS_KEY[r.status])}
            </Badge>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("history.findingsCount", { count: r.findingsCount })}</span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => onView(r.runId)}>
                {t("history.open")}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onDelete(r.runId)}
                aria-label={t("history.delete")}
                data-testid="strix-history-delete"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
