"use client"

/**
 * React context shared between the inspector panel and per-kind form
 * components. Lets sub-components (notably `ExpressionField`) reach the
 * editor store + currently-selected node id without prop-drilling through
 * every form signature.
 *
 * The default value is `null` (provider not mounted) — consumers gracefully
 * degrade, e.g., `ExpressionField` renders without autocomplete when the
 * context is absent, which matches headless-test scenarios.
 */

import { createContext, useContext, type ReactNode } from "react"
import type { EditorStore } from "@/lib/workflow/editor/store"

export interface InspectorExpressionCtx {
  store: EditorStore
  currentNodeId: string
}

const InspectorExpressionContext = createContext<InspectorExpressionCtx | null>(null)

export function InspectorExpressionProvider({
  store,
  currentNodeId,
  children,
}: {
  store: EditorStore
  currentNodeId: string
  children: ReactNode
}) {
  return (
    <InspectorExpressionContext.Provider value={{ store, currentNodeId }}>
      {children}
    </InspectorExpressionContext.Provider>
  )
}

export function useInspectorExpressionCtx(): InspectorExpressionCtx | null {
  return useContext(InspectorExpressionContext)
}
