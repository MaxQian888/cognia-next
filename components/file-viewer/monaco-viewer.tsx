"use client"

import dynamic from "next/dynamic"
import type { FileViewerRenderProps } from "@/lib/file-viewer/types"

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
})

/** The minimal editor surface this viewer drives on mount. */
interface RevealableEditor {
  revealLineInCenter?: (lineNumber: number) => void
  setPosition?: (position: { lineNumber: number; column: number }) => void
  focus?: () => void
}

/**
 * Read-only text fallback, and the only viewer that can honour a `line:column`.
 *
 * Deliberately a plain `@monaco-editor/react` instance rather than
 * `mountMonacoWorkbench`: a transient viewer that registered itself as the
 * vscode-shim's active text editor would confuse the LSP providers for whatever
 * the user actually has open. Monaco infers the language from `path`.
 */
export default function MonacoViewer({ text, relPath, line, column }: FileViewerRenderProps) {
  return (
    <div className="h-full" data-testid="file-viewer-monaco">
      <MonacoEditor
        height="100%"
        path={relPath}
        value={text}
        options={{
          readOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 13,
          scrollBeyondLastLine: false,
        }}
        onMount={(editor: RevealableEditor) => {
          if (line == null) return
          try {
            editor.revealLineInCenter?.(line)
            editor.setPosition?.({ lineNumber: line, column: column ?? 1 })
            editor.focus?.()
          } catch {
            // A reveal is a convenience; failing it must not blank the file.
          }
        }}
      />
    </div>
  )
}
