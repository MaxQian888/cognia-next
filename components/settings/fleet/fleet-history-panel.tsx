"use client"

/**
 * FleetHistoryPanel — a compact list of recently-monitored external agent
 * sessions, read live from the `fleetSessions` Dexie table (written by
 * `use-fleet-history-sink` in the main window). History survives island close
 * and app restart, so this is where a user reviews what ran when the overlay
 * wasn't open.
 *
 * The header's "Import" button opens the existing SessionImportDialog
 * (ADR-0062) — the one path that pulls an external agent's full transcript into
 * a cognia conversation — rather than reimplementing session import here. It is
 * panel-level, not per-row: the dialog scans or picks, it does not take a
 * specific monitored session (it can be narrowed to a SOURCE via `sourceId`,
 * but a fleet row is a live run, not an on-disk transcript locator). "Clear"
 * empties the history table (not the source transcripts); "Clear ended"
 * removes finished rows while keeping live ones; single rows can be removed
 * with their inline delete button. When more than one agent kind is present
 * the list grows filter chips, and long histories collapse behind a
 * show-all toggle.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { DownloadIcon, Trash2Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SessionImportDialog } from "@/components/session-import/session-import-dialog"
import { AgentBadge } from "@/components/fleet/agent-badge"
import {
  clearEndedFleetHistory,
  clearFleetHistory,
  deleteFleetHistory,
  listFleetHistory,
  type FleetSessionHistoryRow,
} from "@/lib/db/fleet-sessions"
import type { FleetAgent } from "@/lib/fleet/types"
import { formatElapsed, truncateLine } from "@/lib/fleet/format"
import { cn } from "@/lib/utils"

/** Rows shown before the show-all toggle expands the list. */
const COLLAPSED_LIMIT = 8
/** Hard ceiling on how much history the panel ever loads. */
const EXPANDED_LIMIT = 50

type AgentFilter = FleetAgent | "all"

/** Distinct agents present in the rows, in first-seen order. Pure. */
export function agentsIn(rows: readonly FleetSessionHistoryRow[]): FleetAgent[] {
  const seen: FleetAgent[] = []
  for (const r of rows) {
    if (!seen.includes(r.agent)) seen.push(r.agent)
  }
  return seen
}

export function FleetHistoryPanel() {
  const t = useTranslations("settings.fleet.history")
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [agentFilter, setAgentFilter] = useState<AgentFilter>("all")
  // Snapshot "now" once at mount — this is a settings panel, not a live ticker,
  // so relative labels don't need to update every second (and Date.now() in
  // the render body would be an impure read).
  const [now] = useState(() => Date.now())
  const rows = useLiveQuery(() => listFleetHistory(EXPANDED_LIMIT), [], [])

  const guarded = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  const agents = agentsIn(rows ?? [])
  const filtered = (rows ?? []).filter((r) => agentFilter === "all" || r.agent === agentFilter)
  const visible = expanded ? filtered : filtered.slice(0, COLLAPSED_LIMIT)
  const overflow = filtered.length - visible.length
  const hasEnded = (rows ?? []).some((r) => r.outcome === "ended")

  return (
    <div className="space-y-2" data-testid="fleet-history-panel">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium">
          {t("title")}
          {(rows?.length ?? 0) > 0 ? (
            <span
              className="ml-1.5 tabular-nums text-muted-foreground"
              data-testid="fleet-history-count"
              aria-label={t("count", { count: rows?.length ?? 0 })}
            >
              {rows?.length}
            </span>
          ) : null}
        </h4>
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
            disabled={busy || !hasEnded}
            onClick={() => void guarded(clearEndedFleetHistory)}
            data-testid="fleet-history-clear-ended"
          >
            {t("clearEnded")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            disabled={busy || (rows?.length ?? 0) === 0}
            onClick={() => void guarded(clearFleetHistory)}
            data-testid="fleet-history-clear"
          >
            <Trash2Icon className="mr-1 size-3" />
            {t("clear")}
          </Button>
        </div>
      </div>

      {agents.length > 1 ? (
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label={t("filterAria")}
          data-testid="fleet-history-filters"
        >
          {(["all", ...agents] as AgentFilter[]).map((value) => (
            <Button
              key={value}
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={agentFilter === value}
              data-testid={`fleet-history-filter-${value}`}
              onClick={() => setAgentFilter(value)}
              className={cn(
                "h-auto rounded-full px-2 py-0.5 text-[10px] font-medium",
                agentFilter === value
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-transparent bg-muted/60 text-muted-foreground hover:bg-muted"
              )}
            >
              {value === "all" ? t("filterAll") : <AgentBadge agent={value} />}
            </Button>
          ))}
        </div>
      ) : null}

      {rows === undefined ? null : filtered.length === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="fleet-history-empty">
          {t("empty")}
        </p>
      ) : (
        <>
          <ul className="space-y-1" data-testid="fleet-history-list">
            {visible.map((row) => (
              <li
                key={row.id}
                data-testid={`fleet-history-row-${row.id}`}
                className="group rounded-md bg-muted/40 px-2 py-1 text-[11px] transition-colors hover:bg-muted/70"
              >
                <div className="flex items-center gap-2">
                  <AgentBadge agent={row.agent} />
                  <span
                    className="min-w-0 flex-1 truncate font-medium"
                    title={row.cwd ?? undefined}
                  >
                    {row.projectName ?? row.sessionId}
                  </span>
                  {row.terminalLabel ? (
                    <span className="shrink-0 text-muted-foreground">{row.terminalLabel}</span>
                  ) : null}
                  {row.outcome === "ended" && row.endedAt !== null ? (
                    <span
                      className="shrink-0 tabular-nums text-muted-foreground"
                      data-testid={`fleet-history-duration-${row.id}`}
                    >
                      {t("ranFor", { duration: formatElapsed(row.startedAt, row.endedAt) })}
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "shrink-0 tabular-nums",
                      row.outcome === "ended"
                        ? "text-muted-foreground"
                        : row.outcome === "detached"
                          ? "text-amber-600"
                          : "text-emerald-500"
                    )}
                    data-testid={`fleet-history-outcome-${row.id}`}
                  >
                    {row.outcome === "ended"
                      ? t("endedAgo", { ago: formatElapsed(row.endedAt ?? row.startedAt, now) })
                      : row.outcome === "detached"
                        ? t("detachedAgo", { ago: formatElapsed(row.updatedAt, now) })
                        : t("activeFor", { duration: formatElapsed(row.startedAt, now) })}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5 shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                    disabled={busy}
                    aria-label={t("delete")}
                    data-testid={`fleet-history-delete-${row.id}`}
                    onClick={() => void guarded(() => deleteFleetHistory(row.id))}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </div>
                {row.firstPrompt ? (
                  <p
                    className="truncate pl-0.5 text-[10px] text-muted-foreground"
                    data-testid={`fleet-history-prompt-${row.id}`}
                  >
                    {truncateLine(row.firstPrompt, 160)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {overflow > 0 || (expanded && filtered.length > COLLAPSED_LIMIT) ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-full text-[11px] text-muted-foreground"
              onClick={() => setExpanded((v) => !v)}
              data-testid="fleet-history-toggle-expand"
            >
              {expanded ? t("showLess") : t("showMore", { count: filtered.length })}
            </Button>
          ) : null}
        </>
      )}
    </div>
  )
}

export default FleetHistoryPanel
