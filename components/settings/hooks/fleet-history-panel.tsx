"use client"

/**
 * FleetHistoryPanel — a compact list of recently-monitored external agent
 * sessions, read live from the `fleetSessions` Dexie table (written by
 * `use-fleet-history-sink` in the main window). History survives island close
 * and app restart, so this is where a user reviews what ran when the overlay
 * wasn't open.
 *
 * "Open in Cognia" reuses the existing SessionImportDialog (ADR-0062) — the
 * one path that pulls an external agent's full transcript into a cognia
 * conversation — rather than reimplementing per-session import. "Clear"
 * empties the history table (not the source transcripts).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { DownloadIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SessionImportDialog } from "@/components/session-import/session-import-dialog"
import { AgentBadge } from "@/components/fleet/agent-badge"
import { clearFleetHistory, listFleetHistory } from "@/lib/db/fleet-sessions"
import { formatElapsed } from "@/lib/fleet/format"
import { cn } from "@/lib/utils"

const HISTORY_LIMIT = 8

export function FleetHistoryPanel() {
  const t = useTranslations("settings.hooks.fleet.history")
  const [clearing, setClearing] = useState(false)
  // Snapshot "now" once at mount — this is a settings panel, not a live ticker,
  // so relative labels don't need to update every second (and Date.now() in
  // the render body would be an impure read).
  const [now] = useState(() => Date.now())
  const rows = useLiveQuery(() => listFleetHistory(HISTORY_LIMIT), [], [])

  const onClear = async () => {
    if (clearing) return
    setClearing(true)
    try {
      await clearFleetHistory()
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="space-y-2" data-testid="fleet-history-panel">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium">{t("title")}</h4>
        <div className="flex items-center gap-1.5">
          <SessionImportDialog
            trigger={
              <Button variant="outline" size="sm" className="h-7 text-[11px]">
                <DownloadIcon className="mr-1 size-3" />
                {t("import")}
              </Button>
            }
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            disabled={clearing || (rows?.length ?? 0) === 0}
            onClick={() => void onClear()}
            data-testid="fleet-history-clear"
          >
            <Trash2Icon className="mr-1 size-3" />
            {t("clear")}
          </Button>
        </div>
      </div>

      {rows === undefined ? null : rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="fleet-history-empty">
          {t("empty")}
        </p>
      ) : (
        <ul className="space-y-1" data-testid="fleet-history-list">
          {rows.map((row) => (
            <li
              key={row.id}
              data-testid={`fleet-history-row-${row.id}`}
              className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1 text-[11px]"
            >
              <AgentBadge agent={row.agent} />
              <span className="min-w-0 flex-1 truncate font-medium">
                {row.projectName ?? row.sessionId}
              </span>
              {row.terminalLabel ? (
                <span className="shrink-0 text-muted-foreground">{row.terminalLabel}</span>
              ) : null}
              <span
                className={cn(
                  "shrink-0 tabular-nums",
                  row.outcome === "ended" ? "text-muted-foreground" : "text-emerald-500"
                )}
                data-testid={`fleet-history-outcome-${row.id}`}
              >
                {row.outcome === "ended"
                  ? t("endedAgo", { ago: formatElapsed(row.endedAt ?? row.startedAt, now) })
                  : t("activeFor", { duration: formatElapsed(row.startedAt, now) })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default FleetHistoryPanel
