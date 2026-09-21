"use client"

// Status bar at the foot of the editor pane — the project editor's answer to
// VS Code's bottom strip. Left: git branch and the live diagnostics summary
// (clicking jumps to the next problem). Right: cursor position and selection
// size, language id, line ending, file size, and the dirty marker — each an
// answer to "what am I editing and what state is it in" that the tab strip
// alone can't carry.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CircleDotIcon,
  GitBranchIcon,
  InfoIcon,
} from "lucide-react"
import { useMonacoMarkers, type EditorLike, type MonacoLike } from "@/hooks/use-monaco-markers"
import type { TextSelectionCoordinates } from "@/types/context-workbench"
import { cn } from "@/lib/utils"
import type { OpenFile } from "./use-project-editor"

interface Props {
  file: OpenFile
  /** Live cursor position, or null until the editor reports one. */
  cursor: { lineNumber: number; column: number } | null
  /** Current selection (used for the "N selected" readout). */
  selection?: TextSelectionCoordinates
  /** Monaco handles once mounted — feeds the diagnostics summary. */
  diagnostics: { monaco: MonacoLike; editor: EditorLike } | null
  /** Git branch for the file's root, when it lives in a repo. */
  branch?: string | null
  density?: "compact" | "touch"
}

function formatBytes(size: number | undefined): string | null {
  if (size === undefined) return null
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function ProjectEditorStatusBar({
  file,
  cursor,
  selection,
  diagnostics,
  branch,
  density = "compact",
}: Props) {
  const t = useTranslations("projectEditor")
  const { summary, next } = useMonacoMarkers(diagnostics?.monaco, diagnostics?.editor)

  const dirty = file.draftContent !== file.savedContent
  const eol = useMemo(
    () => (file.draftContent.includes("\r\n") ? "CRLF" : "LF"),
    [file.draftContent]
  )
  const size = formatBytes(file.sizeBytes)
  const selectedChars =
    selection && selection.kind === "text" ? Math.max(0, selection.end - selection.start) : 0

  return (
    <div
      className={cn(
        "flex h-6 shrink-0 items-center gap-1 border-t bg-muted/30 px-2 text-[11px] text-muted-foreground select-none",
        density === "touch" && "h-8 text-xs"
      )}
      data-testid="project-editor-status-bar"
      role="contentinfo"
      aria-label={t("statusBar.aria")}
    >
      {branch ? (
        <span className="flex items-center gap-1" data-testid="status-branch">
          <GitBranchIcon className="size-3" />
          <span className="max-w-32 truncate">{branch}</span>
        </span>
      ) : null}
      {diagnostics && summary.errors + summary.warnings + summary.infos > 0 ? (
        <button
          type="button"
          className="flex items-center gap-2 rounded-sm px-1 hover:bg-accent"
          onClick={next}
          title={t("statusBar.problemsTooltip")}
          data-testid="status-problems"
        >
          {summary.errors > 0 ? (
            <span className="flex items-center gap-0.5 text-red-500">
              <AlertCircleIcon className="size-3" />
              {summary.errors}
            </span>
          ) : null}
          {summary.warnings > 0 ? (
            <span className="flex items-center gap-0.5 text-amber-500">
              <AlertTriangleIcon className="size-3" />
              {summary.warnings}
            </span>
          ) : null}
          {summary.infos > 0 ? (
            <span className="flex items-center gap-0.5">
              <InfoIcon className="size-3" />
              {summary.infos}
            </span>
          ) : null}
        </button>
      ) : null}

      <span className="ml-auto flex items-center gap-2.5 tabular-nums">
        {cursor ? (
          <span data-testid="status-cursor">
            {t("statusBar.position", { line: cursor.lineNumber, col: cursor.column })}
            {selectedChars > 0 ? (
              <span className="ml-1 text-muted-foreground/70">
                {t("statusBar.selected", { count: selectedChars })}
              </span>
            ) : null}
          </span>
        ) : null}
        {size ? <span data-testid="status-size">{size}</span> : null}
        <span data-testid="status-eol">{eol}</span>
        <span className="font-mono" data-testid="status-language">
          {file.monacoLanguage}
        </span>
        {file.externallyChanged ? (
          <span className="flex items-center gap-0.5 text-amber-500" data-testid="status-external">
            <AlertTriangleIcon className="size-3" />
            {t("statusBar.externallyChanged")}
          </span>
        ) : null}
        {dirty ? (
          <span
            className="flex items-center gap-0.5 text-amber-500"
            title={t("statusBar.unsaved")}
            data-testid="status-dirty"
          >
            <CircleDotIcon className="size-3" />
            {t("statusBar.unsaved")}
          </span>
        ) : null}
      </span>
    </div>
  )
}
