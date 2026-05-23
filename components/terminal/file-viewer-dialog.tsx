"use client"

/**
 * Read-only file viewer for terminal path links (1D).
 *
 * Driven by `useFileViewerStore`. When a terminal link is clicked the
 * store opens with an absolute path (+ optional line/col); this dialog
 * loads the file via `lib/file/file-operations.readTextFile` and renders
 * it in a read-only Monaco editor, revealing the target line.
 *
 * Deliberately a plain read-only `@monaco-editor/react` instance — NOT
 * `mountMonacoWorkbench` — so a transient viewer doesn't register itself
 * as the vscode-shim's active text editor and confuse LSP providers.
 * Monaco infers the language from the `path` prop's extension.
 */

import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { useTranslations } from "next-intl"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { readTextFile } from "@/lib/file/file-operations"
import { useFileViewerStore } from "@/stores/terminal/file-viewer-store"

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
})

/** Minimal Monaco editor surface we drive on mount. */
interface RevealableEditor {
  revealLineInCenter?: (lineNumber: number) => void
  setPosition?: (position: { lineNumber: number; column: number }) => void
  focus?: () => void
}

export function FileViewerDialog() {
  const t = useTranslations("terminal.fileViewer")
  const open = useFileViewerStore((s) => s.open)
  const path = useFileViewerStore((s) => s.path)
  const line = useFileViewerStore((s) => s.line)
  const column = useFileViewerStore((s) => s.column)
  const close = useFileViewerStore((s) => s.close)

  // Single state keyed by the path it was loaded for, so the loading /
  // content / error views derive from `loaded.path === path` rather than
  // an imperative reset (which would be a setState-in-effect anti-pattern).
  const [loaded, setLoaded] = useState<{
    path: string
    content: string | null
    error: string | null
  }>({ path: "", content: null, error: null })

  useEffect(() => {
    if (!open || !path) return
    let cancelled = false
    readTextFile(path)
      .then((text) => {
        if (!cancelled) setLoaded({ path, content: text, error: null })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoaded({
            path,
            content: null,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, path])

  const ready = !!path && loaded.path === path
  const content = ready ? loaded.content : null
  const error = ready ? loaded.error : null

  const locationSuffix = line != null ? `:${line}${column != null ? `:${column}` : ""}` : ""

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent
        className="flex h-[80vh] max-w-4xl flex-col gap-0 p-0"
        data-testid="terminal-file-viewer"
      >
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="truncate font-mono text-sm" title={path ?? undefined}>
            {path ? `${path}${locationSuffix}` : t("title")}
          </DialogTitle>
          <DialogDescription className="sr-only">{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {error ? (
            <p className="p-4 text-sm text-red-500" data-testid="terminal-file-viewer-error">
              {t("error", { message: error })}
            </p>
          ) : content == null ? (
            <p
              className="p-4 text-sm text-muted-foreground"
              data-testid="terminal-file-viewer-loading"
            >
              {t("loading")}
            </p>
          ) : (
            <MonacoEditor
              height="100%"
              path={path ?? undefined}
              value={content}
              options={{
                readOnly: true,
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 13,
                scrollBeyondLastLine: false,
              }}
              onMount={(editor: RevealableEditor) => {
                if (line != null) {
                  try {
                    editor.revealLineInCenter?.(line)
                    editor.setPosition?.({ lineNumber: line, column: column ?? 1 })
                    editor.focus?.()
                  } catch {
                    /* noop */
                  }
                }
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default FileViewerDialog
