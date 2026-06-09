"use client"

/**
 * Fine-grained selector hooks over the editor store's `diagnostics` slice.
 * Mirrors `use-node-decoration.ts`: each hook returns an EMPTY-stable value
 * when no `<EditorStoreProvider>` is mounted (tests, isolated node renders),
 * and uses `useShallow` so unrelated diagnostics churn doesn't re-render the
 * tab badge / a single node's decoration.
 */

import { useShallow } from "zustand/react/shallow"
import { useEditorStoreOrNull } from "./store-context"
import type { EditorState } from "./store"
import type { Diagnostic } from "@/lib/workflow/diagnostics/types"

export interface DiagnosticsSummary {
  errorCount: number
  warningCount: number
  infoCount: number
}

const EMPTY_SUMMARY: DiagnosticsSummary = Object.freeze({
  errorCount: 0,
  warningCount: 0,
  infoCount: 0,
})
const EMPTY_LIST: Diagnostic[] = Object.freeze([]) as Diagnostic[]

/** Severity counts for the Problems tab badge and the save/run gate. */
export function useDiagnosticsSummary(): DiagnosticsSummary {
  const store = useEditorStoreOrNull()
  const selector = useShallow(
    (s: EditorState): DiagnosticsSummary => ({
      errorCount: s.diagnostics.errorCount,
      warningCount: s.diagnostics.warningCount,
      infoCount: s.diagnostics.infoCount,
    })
  )
  return (store ? store(selector) : null) ?? EMPTY_SUMMARY
}

/** Full diagnostics list for the Problems panel. */
export function useDiagnosticsList(): Diagnostic[] {
  const store = useEditorStoreOrNull()
  const list = store ? store((s: EditorState) => s.diagnostics.diagnostics) : null
  return list ?? EMPTY_LIST
}

/** Diagnostics attached to one node — for the corner badge + tooltip. */
export function useNodeDiagnostics(nodeId: string): Diagnostic[] {
  const store = useEditorStoreOrNull()
  const list = store ? store((s: EditorState) => s.diagnostics.byNodeId[nodeId]) : null
  return list ?? EMPTY_LIST
}

/** Diagnostics attached to one edge — for the edge decoration. */
export function useEdgeDiagnostics(edgeId: string): Diagnostic[] {
  const store = useEditorStoreOrNull()
  const list = store ? store((s: EditorState) => s.diagnostics.byEdgeId[edgeId]) : null
  return list ?? EMPTY_LIST
}
