"use client"

/**
 * Subscribe to the Monaco diagnostics markers for a single editor's model and
 * expose them as a sorted list + severity summary, plus navigation helpers.
 *
 * This is the desktop analog of the CM6 light editor's diagnostics status bar
 * (`components/editor/diagnostics`): LSP diagnostics reach Monaco via
 * `setModelMarkers` (see `lib/plugin/vscode-shim/monaco-bridge.ts`), and this
 * hook reads them back through `getModelMarkers` + `onDidChangeMarkers`.
 *
 * Typed against minimal structural interfaces (not the monaco-editor types) so
 * the hook and its consumers stay unit-testable with plain fakes — jsdom can't
 * run a real Monaco instance.
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react"

/** Monaco's numeric MarkerSeverity: Hint=1, Info=2, Warning=4, Error=8. */
export interface RawMarker {
  severity: number
  message: string
  source?: string
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface EditorMarker extends RawMarker {
  severity: number
  kind: "error" | "warning" | "info"
}

export interface MarkerSummary {
  errors: number
  warnings: number
  infos: number
}

export interface MonacoLike {
  editor: {
    getModelMarkers(filter: { resource?: unknown; owner?: string }): RawMarker[]
    onDidChangeMarkers(listener: (resources: unknown[]) => void): { dispose(): void }
  }
}

export interface EditorModelLike {
  uri: { toString(): string }
}

export interface EditorLike {
  getModel(): EditorModelLike | null
  setPosition(position: { lineNumber: number; column: number }): void
  revealLineInCenterIfOutsideViewport(line: number): void
  focus(): void
  getAction(id: string): { run(): void } | null
}

function kindFor(severity: number): EditorMarker["kind"] {
  if (severity >= 8) return "error"
  if (severity >= 4) return "warning"
  return "info"
}

const EMPTY_SUMMARY: MarkerSummary = { errors: 0, warnings: 0, infos: 0 }

export interface UseMonacoMarkersResult {
  markers: EditorMarker[]
  summary: MarkerSummary
  jumpTo: (marker: EditorMarker) => void
  next: () => void
  previous: () => void
}

const EMPTY_MARKERS: EditorMarker[] = []

export function useMonacoMarkers(
  monaco: MonacoLike | null | undefined,
  editor: EditorLike | null | undefined
): UseMonacoMarkersResult {
  // Subscribe to Monaco's external marker store via `useSyncExternalStore` —
  // the idiomatic way to read a mutable external source without a
  // setState-in-effect. The snapshot is cached by a cheap signature so its
  // reference stays stable across renders (otherwise the store would loop).
  const cacheRef = useRef<{ sig: string; markers: EditorMarker[] }>({
    sig: "∅",
    markers: EMPTY_MARKERS,
  })

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!monaco || !editor) return () => {}
      const sub = monaco.editor.onDidChangeMarkers(() => onStoreChange())
      return () => sub.dispose()
    },
    [monaco, editor]
  )

  const getSnapshot = useCallback((): EditorMarker[] => {
    const model = monaco && editor ? editor.getModel() : null
    if (!monaco || !model) {
      if (cacheRef.current.sig !== "∅") cacheRef.current = { sig: "∅", markers: EMPTY_MARKERS }
      return cacheRef.current.markers
    }
    const raw = monaco.editor.getModelMarkers({ resource: model.uri })
    const sig = raw
      .map((m) => `${m.severity}:${m.startLineNumber}:${m.startColumn}:${m.message}`)
      .join("|")
    if (sig === cacheRef.current.sig) return cacheRef.current.markers
    const markers = raw
      .map((m) => ({ ...m, kind: kindFor(m.severity) }))
      .sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn)
    cacheRef.current = { sig, markers }
    return markers
  }, [monaco, editor])

  const markers = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const summary = useMemo<MarkerSummary>(() => {
    if (markers.length === 0) return EMPTY_SUMMARY
    let errors = 0
    let warnings = 0
    let infos = 0
    for (const m of markers) {
      if (m.kind === "error") errors++
      else if (m.kind === "warning") warnings++
      else infos++
    }
    return { errors, warnings, infos }
  }, [markers])

  const jumpTo = useCallback(
    (marker: EditorMarker) => {
      if (!editor) return
      editor.setPosition({ lineNumber: marker.startLineNumber, column: marker.startColumn })
      editor.revealLineInCenterIfOutsideViewport(marker.startLineNumber)
      editor.focus()
    },
    [editor]
  )

  const next = useCallback(() => {
    editor?.getAction("editor.action.marker.next")?.run()
  }, [editor])

  const previous = useCallback(() => {
    editor?.getAction("editor.action.marker.prev")?.run()
  }, [editor])

  return { markers, summary, jumpTo, next, previous }
}
