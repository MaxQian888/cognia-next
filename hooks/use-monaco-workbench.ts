"use client"

import { useCallback, useEffect, useRef } from "react"
import {
  mountMonacoWorkbench,
  type IMonacoEditor,
  type MonacoNamespace,
  type MonacoWorkbenchHandle,
  type MonacoWorkbenchSpec,
} from "@/lib/editor-workbench/monaco-workbench"

export interface UseMonacoWorkbenchResult {
  /**
   * onMount callback for `@monaco-editor/react`'s `<Editor onMount={…} />`.
   * Disposes any previous handle and creates a fresh one tied to the
   * spec held at the time of mount.
   */
  onMount: (editor: IMonacoEditor, monaco: MonacoNamespace) => void
  /** Returns the URI of the currently mounted document, if any. */
  getCurrentUri: () => string | null
}

/**
 * React hook that wires a Monaco editor surface into the workbench. The
 * hook keeps the workbench handle on a ref, so the returned `onMount`
 * stays referentially stable across renders. The handle is automatically
 * disposed when the component unmounts.
 *
 * Pass `spec=null` while the surface has nothing open — the returned
 * `onMount` then becomes a no-op until a real spec is provided.
 */
export function useMonacoWorkbench(spec: MonacoWorkbenchSpec | null): UseMonacoWorkbenchResult {
  const handleRef = useRef<MonacoWorkbenchHandle | null>(null)
  const specRef = useRef<MonacoWorkbenchSpec | null>(spec)
  // eslint-disable-next-line react-hooks/refs -- WIP: sync ref during render so onMount captures latest spec without stale closure. Refactor to useEffect+ref-sync if a render bug surfaces.
  specRef.current = spec

  const onMount = useCallback((editor: IMonacoEditor, monaco: MonacoNamespace) => {
    const current = specRef.current
    if (!current) return
    handleRef.current?.dispose()
    handleRef.current = mountMonacoWorkbench(editor, monaco, current)
  }, [])

  const getCurrentUri = useCallback(() => handleRef.current?.uri ?? null, [])

  useEffect(() => {
    return () => {
      handleRef.current?.dispose()
      handleRef.current = null
    }
  }, [])

  return { onMount, getCurrentUri }
}
