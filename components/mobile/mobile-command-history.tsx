"use client"

/**
 * Mobile command-history viewer (ADR-0039 phase 2).
 *
 * Browse/search over the durable `terminalHistory` table mirrored from the
 * paired desktop by the `terminalHistory` sync handler. The phone has no
 * shell of its own, so tapping a row copies it; the per-row run affordance
 * replays the command ON THE PAIRED DESKTOP via the `terminal_exec`
 * companion RPC (shell mode, remote-control-capability gated on the host)
 * after an explicit confirm, and shows the captured output.
 *
 * Data comes through `useDexieFirstQuery`, so the list renders from Dexie
 * immediately (offline-capable) and kicks a background pull of just this table
 * on mount. Rows are sorted newest-first (`ts` desc) and grouped by project.
 */

import { useMemo, useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { toast } from "sonner"
import { SearchIcon, TerminalSquareIcon } from "lucide-react"

import { MeSection } from "@/components/mobile/me/me-section"
import { AnimatedActionIcon } from "@/components/shared/animated-action-icon"
import { Button } from "@/components/ui/button"
import { CopyIcon as AnimatedCopyIcon } from "@/components/ui/copy"
import { PlayIcon as AnimatedPlayIcon } from "@/components/ui/play"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useDexieFirstQuery } from "@/hooks/data/use-dexie-first-query"
import { getDb } from "@/lib/db/schema"
import type { TerminalHistoryRow } from "@/lib/db/terminal-history"
import { execTerminalCommand, type RemoteExecResult } from "@/lib/terminal/remote-api"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { Surface } from "@/components/surface/surface"

/** Replay-dialog lifecycle: confirm → running → captured result. */
type RunPhase = { kind: "confirm" } | { kind: "running" } | { kind: "done"; result: RemoteExecResult }

/** Wall-clock budget for a replayed command — a phone UI shouldn't hang longer. */
const RUN_TIMEOUT_MS = 60_000

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
  const now = useNow()
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

  // Replay-on-desktop dialog state. `runTarget` holds the command being
  // confirmed/run; closing the dialog clears both.
  const [runTarget, setRunTarget] = useState<string | null>(null)
  const [runPhase, setRunPhase] = useState<RunPhase>({ kind: "confirm" })

  const openRunDialog = (command: string) => {
    setRunTarget(command)
    setRunPhase({ kind: "confirm" })
  }

  const closeRunDialog = () => {
    setRunTarget(null)
    setRunPhase({ kind: "confirm" })
  }

  const handleRun = async (command: string) => {
    setRunPhase({ kind: "running" })
    try {
      // Shell mode: history rows are full shell lines (pipes, &&, redirects),
      // not bare argv — the host wraps them in its platform shell.
      const result = await execTerminalCommand({
        command,
        shell: true,
        timeoutMs: RUN_TIMEOUT_MS,
      })
      setRunPhase({ kind: "done", result })
    } catch (error) {
      closeRunDialog()
      toast.error(t("runError", { message: error instanceof Error ? error.message : String(error) }))
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
        <Surface
          asChild
          radius="panel"
          className="border px-3 py-6 text-center text-xs text-muted-foreground"
        >
          <p data-testid="command-history-empty">{t("empty")}</p>
        </Surface>
      ) : groups.length === 0 ? (
        <Surface
          asChild
          radius="panel"
          className="border px-3 py-6 text-center text-xs text-muted-foreground"
        >
          <p data-testid="command-history-no-results">{t("noResults")}</p>
        </Surface>
      ) : (
        groups.map((group) => (
          <MeSection
            key={group.projectId || "__none__"}
            title={group.projectId || t("noProject")}
            withSeparators
            testid={`command-history-group-${group.projectId || "none"}`}
          >
            {group.rows.map((row) => (
              <div key={row.id} className="flex w-full items-stretch">
                <button
                  type="button"
                  onClick={() => handleCopy(row.command)}
                  aria-label={t("copyAria", { command: row.command })}
                  data-testid={`command-history-row-${row.id}`}
                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50 active:bg-accent"
                >
                  <TerminalSquareIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate font-mono text-xs">{row.command}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("uses", { count: row.uses })} ·{" "}
                      {format.relativeTime(new Date(row.ts), now)}
                    </span>
                  </span>
                  <AnimatedActionIcon
                    icon={AnimatedCopyIcon}
                    size={16}
                    className="text-muted-foreground"
                  />
                </button>
                <button
                  type="button"
                  onClick={() => openRunDialog(row.command)}
                  aria-label={t("runAria", { command: row.command })}
                  data-testid={`command-history-run-${row.id}`}
                  className="flex shrink-0 items-center px-3 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground active:bg-accent"
                >
                  <AnimatedActionIcon icon={AnimatedPlayIcon} size={16} />
                </button>
              </div>
            ))}
          </MeSection>
        ))
      )}

      <Dialog open={runTarget !== null} onOpenChange={(open) => !open && closeRunDialog()}>
        <DialogContent className="max-w-[92vw] rounded-xl" data-testid="command-history-run-dialog">
          <DialogHeader>
            <DialogTitle>
              {runPhase.kind === "done" ? t("run.resultTitle") : t("run.confirmTitle")}
            </DialogTitle>
            <DialogDescription className="break-all font-mono text-xs">
              {runTarget ?? ""}
            </DialogDescription>
          </DialogHeader>

          {runPhase.kind === "confirm" ? (
            <p className="text-xs text-muted-foreground">{t("run.confirmBody")}</p>
          ) : null}
          {runPhase.kind === "running" ? (
            <p className="text-xs text-muted-foreground" data-testid="command-history-run-running">
              {t("run.running")}
            </p>
          ) : null}
          {runPhase.kind === "done" ? (
            <div className="space-y-2" data-testid="command-history-run-result">
              <p className="text-xs text-muted-foreground">
                {runPhase.result.timedOut
                  ? t("run.timedOut")
                  : t("run.exitCode", { code: runPhase.result.exitCode ?? "?" })}
              </p>
              <pre className="max-h-60 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap break-all">
                {runPhase.result.stdout || runPhase.result.stderr || t("run.noOutput")}
              </pre>
              {runPhase.result.stdout && runPhase.result.stderr ? (
                <pre className="max-h-40 overflow-auto rounded border border-destructive/40 bg-destructive/5 p-2 font-mono text-[11px] whitespace-pre-wrap break-all">
                  {runPhase.result.stderr}
                </pre>
              ) : null}
            </div>
          ) : null}

          <DialogFooter className="flex-row justify-end gap-2">
            {runPhase.kind === "confirm" ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={closeRunDialog}
                  data-testid="command-history-run-cancel"
                >
                  {t("run.cancel")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => runTarget && void handleRun(runTarget)}
                  data-testid="command-history-run-confirm"
                >
                  {t("run.confirm")}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={runPhase.kind === "running"}
                onClick={closeRunDialog}
                data-testid="command-history-run-close"
              >
                {t("run.close")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
