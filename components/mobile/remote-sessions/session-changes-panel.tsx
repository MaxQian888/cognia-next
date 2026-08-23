"use client"

/**
 * Changes tab of the mobile remote-session view.
 *
 * Deliberately NOT the desktop diff surface: `/source-control` renders through
 * `DiffPane` → `diff-viewer.tsx` → Monaco, which is neither sized nor licensed
 * for a phone bundle. Bodies here go through {@link DiffBlock}, the pure-DOM
 * unified-diff renderer the chat transcript already uses.
 *
 * Every file that will not render a body says why. See
 * `lib/task-workspace/run-changes.ts` for the reasons and for why an empty
 * diff pane is the outcome this whole path is built to avoid.
 */

import { useCallback, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"

import { DiffBlock } from "@/components/chat/renderers/diff-block"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { RunChangeFile } from "@/lib/task-workspace/run-changes"
import { useSessionChanges } from "./use-session-changes"

/** Shared empty set: a turn with nothing open must not allocate a new one. */
const NO_PATHS: ReadonlySet<string> = new Set()

export interface SessionChangesPanelProps {
  sessionId: string
}

function FileStats({ file }: { file: RunChangeFile }) {
  // Rendered only when the ledger actually stored counts — a created file has
  // none, and "+0 −0" would state that an added file added nothing.
  if (!file.stats) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
      <span className="text-emerald-600 dark:text-emerald-400">+{file.stats.additions}</span>
      <span className="text-red-600 dark:text-red-400">−{file.stats.deletions}</span>
    </span>
  )
}

export function SessionChangesPanel({ sessionId }: SessionChangesPanelProps) {
  const t = useTranslations("mobile.remoteSessions.detail.changes")
  const format = useFormatter()
  const { loading, error, untracked, runs, selectedRunId, selectRun, changes, diffs, loadDiff } =
    useSessionChanges(sessionId)
  // Expansion belongs to ONE turn, so it is stamped with the run it was made
  // in and ignored for any other. Two turns routinely touch the same path, and
  // a row left open across a switch would show the previous turn's body under
  // the new turn's file. Derived rather than cleared in an effect, so there is
  // no render where the stale set is still the live one.
  const [expansion, setExpansion] = useState<{ runId?: string; paths: ReadonlySet<string> }>(
    () => ({ paths: NO_PATHS })
  )
  const shownRunId = changes?.runId
  const expanded = expansion.runId === shownRunId ? expansion.paths : NO_PATHS

  const toggle = useCallback(
    (file: RunChangeFile) => {
      // Fetched outside the updater: React may invoke an updater twice, and a
      // state reducer is not where a request belongs. Opening is the only
      // direction that fetches, and the hook ignores a repeat ask.
      if (!expanded.has(file.path) && file.availability === "available") loadDiff(file.path)
      setExpansion((prev) => {
        const base = prev.runId === shownRunId ? prev.paths : NO_PATHS
        const paths = new Set(base)
        if (paths.has(file.path)) paths.delete(file.path)
        else paths.add(file.path)
        return { ...(shownRunId ? { runId: shownRunId } : {}), paths }
      })
    },
    [expanded, loadDiff, shownRunId]
  )

  const selectedRun = runs.find((run) => run.runId === selectedRunId)
  const runPending = selectedRun?.state === "running" || selectedRun?.state === "settling"

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3" data-testid="session-changes-panel">
      {runs.length > 1 ? (
        <select
          className="mb-3 w-full rounded-md border bg-background px-2 py-1.5 text-xs"
          value={selectedRunId ?? ""}
          onChange={(event) => selectRun(event.target.value)}
          aria-label={t("runAria")}
          data-testid="session-changes-run"
        >
          {runs.map((run, index) => (
            <option key={run.runId} value={run.runId}>
              {t("runOption", {
                // Newest first, so the oldest turn is number 1.
                index: runs.length - index,
                time: format.dateTime(run.createdAt, { dateStyle: "short", timeStyle: "short" }),
              })}
            </option>
          ))}
        </select>
      ) : null}

      {loading ? (
        <p className="text-xs text-muted-foreground">{t("loading")}</p>
      ) : error ? (
        <p className="text-xs text-destructive" data-testid="session-changes-error">
          {t("error", { reason: error })}
        </p>
      ) : untracked ? (
        <p className="text-xs text-muted-foreground" data-testid="session-changes-untracked">
          {t("untracked")}
        </p>
      ) : runPending && !changes ? (
        <p className="text-xs text-muted-foreground" data-testid="session-changes-pending">
          {t("pending")}
        </p>
      ) : !changes || changes.files.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="session-changes-empty">
          {t("empty")}
        </p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span data-testid="session-changes-totals">
              {t("totals", {
                files: changes.totals.files,
                additions: changes.totals.additions,
                deletions: changes.totals.deletions,
              })}
            </span>
            {changes.totals.withheld > 0 ? (
              <Badge variant="outline" className="text-[10px]" data-testid="session-changes-withheld">
                {t("withheld", { count: changes.totals.withheld })}
              </Badge>
            ) : null}
          </div>

          <ul className="flex flex-col gap-1" data-testid="session-changes-list">
            {changes.files.map((file) => {
              const open = expanded.has(file.path)
              const diff = diffs[file.path]
              return (
                <li key={file.path} className="rounded-md border">
                  <button
                    type="button"
                    onClick={() => toggle(file)}
                    aria-expanded={open}
                    aria-label={open ? t("collapseDiff", { path: file.path }) : t("expandDiff", { path: file.path })}
                    className="flex w-full items-center gap-2 px-2 py-2 text-left"
                  >
                    {open ? (
                      <ChevronDownIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRightIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11px]">{file.path}</span>
                      {file.oldPath ? (
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {t("renamedFrom", { path: file.oldPath })}
                        </span>
                      ) : null}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "shrink-0 text-[10px]",
                        file.kind === "deleted" && "text-red-600 dark:text-red-400"
                      )}
                    >
                      {t(`kinds.${file.kind}`)}
                    </Badge>
                    <FileStats file={file} />
                  </button>

                  {open ? (
                    <div className="border-t px-2 py-2">
                      {file.availability !== "available" ? (
                        <p
                          className="text-[11px] text-muted-foreground"
                          data-testid={`session-changes-unavailable-${file.availability}`}
                        >
                          {t(`unavailable.${file.availability}`)}
                        </p>
                      ) : diff === undefined || diff.status === "loading" ? (
                        <p className="text-[11px] text-muted-foreground">{t("loadingDiff")}</p>
                      ) : diff.status === "error" ? (
                        <p className="text-[11px] text-destructive">
                          {t("diffError", { reason: diff.message })}
                        </p>
                      ) : diff.status === "empty" ? (
                        <p className="text-[11px] text-muted-foreground" data-testid="session-changes-diff-empty">
                          {t("diffEmpty")}
                        </p>
                      ) : (
                        <DiffBlock content={diff.text} filename={file.path} className="my-0" />
                      )}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
