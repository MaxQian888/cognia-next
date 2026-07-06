"use client"

/**
 * Mobile command-history viewer (ADR-0039 phase 2).
 *
 * Read-only browse/search over the durable `terminalHistory` table mirrored
 * from the paired desktop by the `terminalHistory` sync handler. The phone has
 * no shell, so this never re-runs a command — `cwd`/`shell` are machine-local
 * and not portable — the only affordance is tap-to-copy.
 *
 * Data comes through `useDexieFirstQuery`, so the list renders from Dexie
 * immediately (offline-capable) and kicks a background pull of just this table
 * on mount. Rows are sorted newest-first (`ts` desc) and grouped by project.
 */

import { useMemo, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"
import { CopyIcon, SearchIcon, TerminalSquareIcon } from "lucide-react"

import { MeSection } from "@/components/mobile/me/me-section"
import { Input } from "@/components/ui/input"
import { useDexieFirstQuery } from "@/hooks/data/use-dexie-first-query"
import { getDb } from "@/lib/db/schema"
import type { TerminalHistoryRow } from "@/lib/db/terminal-history"
import { writeClipboardText } from "@/lib/tauri/clipboard"

interface ProjectGroup {
  /** Owning project id, or `""` for the projectless bucket. */
  projectId: string
  rows: TerminalHistoryRow[]
}

/**
 * Bucket rows by `projectId`, preserving their incoming (ts-desc) order within
 * each bucket. Named projects sort alphabetically; the projectless bucket (`""`)
 * always sinks to the bottom so it reads as a catch-all.
 */
function groupByProject(rows: TerminalHistoryRow[]): ProjectGroup[] {
  const byProject = new Map<string, TerminalHistoryRow[]>()
  for (const row of rows) {
    const existing = byProject.get(row.projectId)
    if (existing) existing.push(row)
    else byProject.set(row.projectId, [row])
  }
  return [...byProject.entries()]
    .map(([projectId, groupRows]) => ({ projectId, rows: groupRows }))
    .sort((a, b) => {
      if (a.projectId === "") return 1
      if (b.projectId === "") return -1
      return a.projectId.localeCompare(b.projectId)
    })
}

export function MobileCommandHistory() {
  const t = useTranslations("mobile.commandHistory")
  const format = useFormatter()
  const [query, setQuery] = useState("")

  const { data } = useDexieFirstQuery<TerminalHistoryRow[]>({
    query: () => getDb().terminalHistory.orderBy("ts").reverse().toArray(),
    deps: [],
    initial: [],
    table: "terminalHistory",
  })
  // Stabilize the fallback array so the `filtered` memo below doesn't recompute
  // on every render when Dexie hands back the same `data` reference.
  const rows = useMemo(() => data ?? [], [data])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) => row.command.toLowerCase().includes(q))
  }, [rows, query])

  const groups = useMemo(() => groupByProject(filtered), [filtered])

  const handleCopy = async (command: string) => {
    try {
      await writeClipboardText(command)
      toast.success(t("copied"))
    } catch {
      toast.error(t("copyError"))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-xs text-muted-foreground" data-testid="command-history-intro">
        {t("intro")}
      </p>

      <div className="relative">
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchAria")}
          className="pl-9"
          data-testid="command-history-search"
        />
      </div>

      {rows.length === 0 ? (
        <p
          className="rounded-xl border bg-card px-3 py-6 text-center text-xs text-muted-foreground"
          data-testid="command-history-empty"
        >
          {t("empty")}
        </p>
      ) : groups.length === 0 ? (
        <p
          className="rounded-xl border bg-card px-3 py-6 text-center text-xs text-muted-foreground"
          data-testid="command-history-no-results"
        >
          {t("noResults")}
        </p>
      ) : (
        groups.map((group) => (
          <MeSection
            key={group.projectId || "__none__"}
            title={group.projectId || t("noProject")}
            withSeparators
            testid={`command-history-group-${group.projectId || "none"}`}
          >
            {group.rows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => handleCopy(row.command)}
                aria-label={t("copyAria", { command: row.command })}
                data-testid={`command-history-row-${row.id}`}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50 active:bg-accent"
              >
                <TerminalSquareIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-mono text-xs">{row.command}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {t("uses", { count: row.uses })} · {format.relativeTime(new Date(row.ts))}
                  </span>
                </span>
                <CopyIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            ))}
          </MeSection>
        ))
      )}
    </div>
  )
}
