"use client"

/**
 * WorkspaceFilePreview — the phone's answer to "show me the file the agent
 * read".
 *
 * A file link in a chat tool row reveals the workspace panel; on the desktop
 * dock that lands in the editable Monaco workbench. On a phone the same reveal
 * used to land behind the task ledger (and, once past it, in an editor whose
 * failed read left a blank pane with no explanation), so tapping a path showed
 * nothing at all. This pane is the focused, read-only surface the reveal opens
 * there instead:
 *
 * - The text comes from the Host over the companion transport
 *   (`loadWorkspaceText` → `fs_stat_workspace_file` + `fs_read_workspace_file`).
 *   A paired phone has no local copy of the workspace, so there is nothing else
 *   it could read.
 * - CodeMirror (`LightCodeEditor`) rather than Monaco, read-only, for the same
 *   reason the mobile project editor uses it: Monaco's virtual-keyboard and
 *   touch handling are unusable in the Capacitor WebView.
 * - Loading, failure (with a retry) and an empty file each render as a state of
 *   their own, so a tap never ends on a blank surface.
 * - "Edit" hands over to the full workspace editor at the same line.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ViewPlugin } from "@codemirror/view"
import type { Extension } from "@codemirror/state"
import { ArrowLeftIcon, FileWarningIcon, PencilIcon, RotateCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FileTypeIcon } from "@/components/shared/file-type-icon"
import { LightCodeEditor } from "@/components/editor/light-code-editor"
import { languageFromPath } from "@/components/editor/editor-language"
import { revealLightEditorLine } from "@/components/editor/project/light-editor-goto"
import { loadWorkspaceText, type WorkspaceTextLoad } from "@/lib/file-viewer/load-workspace-text"
import { MAX_VIEWER_BYTES } from "@/lib/file-viewer/probe"
import { fileViewerErrorMessageKey } from "@/lib/file-viewer/types"

export interface WorkspaceFilePreviewProps {
  /** Absolute Host root the read is confined to. */
  root: string
  /** POSIX path relative to `root`. */
  relPath: string
  /** 1-based line the tool call named, revealed once the text is on screen. */
  line?: number
  column?: number
  /** Return to the workspace surfaces (tree, task ledger, review). */
  onBack: () => void
  /** Hand the file to the editable workspace editor at the same location. */
  onOpenInEditor: () => void
}

/** Read-only text never changes; LightCodeEditor still requires a handler. */
const IGNORE_EDIT = () => {}

function splitPath(relPath: string): { name: string; dir: string } {
  const cut = relPath.lastIndexOf("/")
  return cut < 0
    ? { name: relPath, dir: "" }
    : { name: relPath.slice(cut + 1), dir: relPath.slice(0, cut) }
}

/** Centre `line` once the view is live — the same reveal the mobile editor uses. */
function revealLineExtension(line: number | undefined, column: number | undefined): Extension[] {
  if (line === undefined || line < 1) return []
  return [
    ViewPlugin.define((view) => {
      let disposed = false
      // Dispatching from inside a plugin constructor is illegal — the view is
      // mid-update — hence the microtask.
      queueMicrotask(() => {
        if (!disposed) revealLightEditorLine(view, line, column ?? 1)
      })
      return {
        destroy() {
          disposed = true
        },
      }
    }),
  ]
}

export function WorkspaceFilePreview({
  root,
  relPath,
  line,
  column,
  onBack,
  onOpenInEditor,
}: WorkspaceFilePreviewProps) {
  const t = useTranslations("artifacts.workspace.filePreview")
  const tViewer = useTranslations("fileViewer")
  const [attempt, setAttempt] = useState(0)
  const requestKey = `${root}\u0000${relPath}\u0000${attempt}`
  const [result, setResult] = useState<{ key: string; load: WorkspaceTextLoad } | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadWorkspaceText(root, relPath).then((load) => {
      // A slower read for a file the user already moved away from must not
      // paint over the one on screen.
      if (!cancelled) setResult({ key: requestKey, load })
    })
    return () => {
      cancelled = true
    }
  }, [requestKey, root, relPath])

  // Derived rather than reset in the effect: a stale result is simply not this
  // request's, which reads as loading without a second state write.
  const load = result?.key === requestKey ? result.load : null
  const retry = useCallback(() => setAttempt((current) => current + 1), [])
  const extensions = useMemo(() => revealLineExtension(line, column), [line, column])
  const { name, dir } = splitPath(relPath)
  const location = line ? `${name}:${line}` : name

  let body: React.ReactNode
  if (!load) {
    body = (
      <div
        role="status"
        data-testid="workspace-file-preview-loading"
        className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
      >
        <Spinner />
        {tViewer("loading")}
      </div>
    )
  } else if (!load.ok) {
    body = (
      <div
        role="alert"
        data-testid="workspace-file-preview-error"
        data-error-code={load.code}
        className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <FileWarningIcon aria-hidden className="size-6 text-destructive" />
        <p className="max-w-xs text-sm text-destructive [overflow-wrap:anywhere]">
          {tViewer(fileViewerErrorMessageKey(load.code), {
            limit: `${MAX_VIEWER_BYTES / (1024 * 1024)} MB`,
          })}
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={retry}
          data-testid="workspace-file-preview-retry"
        >
          <RotateCwIcon aria-hidden className="size-4" />
          {tViewer("retry")}
        </Button>
      </div>
    )
  } else if (load.text.length === 0) {
    body = (
      <div
        data-testid="workspace-file-preview-empty"
        className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
      >
        {t("emptyFile")}
      </div>
    )
  } else {
    body = (
      <LightCodeEditor
        value={load.text}
        onChange={IGNORE_EDIT}
        language={languageFromPath(relPath)}
        readOnly
        diagnostics={false}
        statusBar={false}
        closeBrackets={false}
        wordWrap
        extensions={extensions}
        aria-label={relPath}
        data-testid="workspace-file-preview-content"
        className="h-full"
      />
    )
  }

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 max-w-full flex-col overflow-hidden"
      data-testid="workspace-file-preview"
    >
      <div
        className="flex min-w-0 shrink-0 items-center gap-1.5 border-b bg-muted/20 px-1.5 py-1"
        data-testid="workspace-file-preview-header"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-10 shrink-0"
          aria-label={t("back")}
          onClick={onBack}
          data-testid="workspace-file-preview-back"
        >
          <ArrowLeftIcon aria-hidden className="size-4" />
        </Button>
        <FileTypeIcon path={relPath} className="size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm font-medium"
            title={relPath}
            data-testid="workspace-file-preview-name"
          >
            {location}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {dir ? `${dir} · ${t("readOnly")}` : t("readOnly")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 shrink-0"
          aria-label={t("openInEditorLabel")}
          onClick={onOpenInEditor}
          data-testid="workspace-file-preview-edit"
        >
          <PencilIcon aria-hidden className="size-3.5" />
          {t("openInEditor")}
        </Button>
      </div>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">{body}</div>
    </div>
  )
}
