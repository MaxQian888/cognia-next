"use client"

/**
 * Desktop (Monaco) diagnostics status bar + expandable Problems list — the
 * counterpart to the CM6 light editor's status bar (`./light-code-editor`).
 * Reads LSP markers through `useMonacoMarkers` and lets the user jump between
 * problems or open a list that reveals each one in the editor.
 *
 * Renders nothing until both `monaco` and `editor` are available (i.e. after
 * the editor mounts), so it's safe to drop into any Monaco surface.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlertCircle, AlertTriangle, ChevronDown, ChevronUp, Info, ListChecks } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  useMonacoMarkers,
  type MonacoLike,
  type EditorLike,
  type EditorMarker,
} from "@/hooks/use-monaco-markers"

export interface MonacoDiagnosticsBarProps {
  monaco: MonacoLike | null | undefined
  editor: EditorLike | null | undefined
  className?: string
}

function SeverityIcon({ kind }: { kind: EditorMarker["kind"] }) {
  if (kind === "error")
    return <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
  if (kind === "warning")
    return <AlertTriangle className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
  return <Info className="size-3.5 shrink-0 text-sky-500" aria-hidden="true" />
}

export function MonacoDiagnosticsBar({ monaco, editor, className }: MonacoDiagnosticsBarProps) {
  const t = useTranslations("editor.diagnostics")
  const { markers, summary, jumpTo, next, previous } = useMonacoMarkers(monaco, editor)
  const [expanded, setExpanded] = useState(false)

  if (!monaco || !editor) return null

  const total = summary.errors + summary.warnings + summary.infos

  return (
    <div
      className={cn("flex flex-col border-t text-xs", className)}
      data-testid="monaco-diagnostics-bar"
    >
      {expanded && total > 0 ? (
        <ul
          className="max-h-40 overflow-auto border-b"
          data-testid="monaco-problems-list"
          aria-label={t("toggleProblems")}
        >
          {markers.map((mk, i) => (
            <li key={`${mk.startLineNumber}:${mk.startColumn}:${i}`}>
              <button
                type="button"
                onClick={() => jumpTo(mk)}
                className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-muted"
              >
                <SeverityIcon kind={mk.kind} />
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {mk.startLineNumber}:{mk.startColumn}
                </span>
                <span className="truncate">{mk.message}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 px-2 py-1 text-muted-foreground"
      >
        {total === 0 ? (
          <span>{t("noProblems")}</span>
        ) : (
          <>
            {summary.errors > 0 ? (
              <span className="flex items-center gap-1 text-destructive" aria-label={t("errors")}>
                <AlertCircle className="size-3.5" aria-hidden="true" />
                {summary.errors}
              </span>
            ) : null}
            {summary.warnings > 0 ? (
              <span className="flex items-center gap-1 text-amber-500" aria-label={t("warnings")}>
                <AlertTriangle className="size-3.5" aria-hidden="true" />
                {summary.warnings}
              </span>
            ) : null}
          </>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            aria-label={t("previousProblem")}
            onClick={previous}
            disabled={total === 0}
            className="rounded p-0.5 hover:bg-muted disabled:opacity-40"
          >
            <ChevronUp className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t("nextProblem")}
            onClick={next}
            disabled={total === 0}
            className="rounded p-0.5 hover:bg-muted disabled:opacity-40"
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t("toggleProblems")}
            aria-pressed={expanded}
            onClick={() => setExpanded((e) => !e)}
            disabled={total === 0}
            className={cn(
              "rounded p-0.5 hover:bg-muted disabled:opacity-40",
              expanded && "bg-muted text-foreground"
            )}
          >
            <ListChecks className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}
