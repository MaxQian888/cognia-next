/**
 * A2UI Context Hooks
 * React context definitions and consumer hooks for the A2UI system.
 *
 * Split into two contexts for performance:
 * - A2UIActionsContext: Stable references (actions, helpers) that rarely change
 * - A2UIDataContext: Frequently changing data (surface, dataModel, resolvers)
 *
 * Use useA2UIActions() when you only need stable actions (avoids data re-renders).
 * Use useA2UIData() when you only need data/resolvers.
 * Use useA2UIContext() for backward compatibility (merges both).
 */

import { createContext, useContext, useCallback, useMemo } from "react"
import type { A2UIComponent } from "@/types/a2ui/schema"
import { getValueByPath } from "@/lib/a2ui/data-model"
import type {
  A2UIActionsContextValue,
  A2UIDataContextValue,
  A2UIContextValue,
} from "@/types/a2ui/context"

// ---------------------------------------------------------------------------
// React Context objects (consumed by hooks below, provided by A2UIProvider)
// ---------------------------------------------------------------------------

export const A2UIActionsCtx = createContext<A2UIActionsContextValue | null>(null)
export const A2UIDataCtx = createContext<A2UIDataContextValue | null>(null)

// ---------------------------------------------------------------------------
// Consumer hooks
// ---------------------------------------------------------------------------

/**
 * Hook to access stable A2UI actions (won't re-render on data changes)
 */
export function useA2UIActions(): A2UIActionsContextValue {
  const context = useContext(A2UIActionsCtx)
  if (!context) {
    throw new Error("useA2UIActions must be used within an A2UIProvider")
  }
  return context
}

/**
 * Hook to access A2UI data and resolvers (re-renders on data changes)
 */
export function useA2UIData(): A2UIDataContextValue {
  const context = useContext(A2UIDataCtx)
  if (!context) {
    throw new Error("useA2UIData must be used within an A2UIProvider")
  }
  return context
}

/**
 * Hook to access full A2UI context (backward-compatible, merges both contexts)
 *
 * @deprecated Prefer useA2UIActions() + useA2UIData() for better performance.
 * useA2UIContext() re-renders on both action and data changes.
 */
export function useA2UIContext(): A2UIContextValue {
  const actions = useContext(A2UIActionsCtx)
  const data = useContext(A2UIDataCtx)
  if (!actions || !data) {
    throw new Error("useA2UIContext must be used within an A2UIProvider")
  }
  return useMemo(() => ({ ...actions, ...data }), [actions, data])
}

/**
 * Hook to get a specific component from context
 */
export function useA2UIComponent(componentId: string): A2UIComponent | undefined {
  const { getComponent } = useA2UIActions()
  return getComponent(componentId)
}

/**
 * Hook for data binding - returns value and setter
 */
export function useA2UIBinding<T>(path: string, defaultValue: T): [T, (value: T) => void] {
  const { dataModel } = useA2UIData()
  const { setDataValue } = useA2UIActions()

  const value = useMemo(() => {
    const resolved = getValueByPath<T>(dataModel, path)
    return resolved ?? defaultValue
  }, [dataModel, path, defaultValue])

  const setValue = useCallback(
    (newValue: T) => {
      setDataValue(path, newValue)
    },
    [setDataValue, path]
  )

  return [value, setValue]
}

/**
 * Hook for component visibility based on data binding
 */
export function useA2UIVisibility(visible?: boolean | { path: string }): boolean {
  const { resolveBoolean } = useA2UIData()

  if (visible === undefined) {
    return true
  }

  return resolveBoolean(visible, true)
}

/**
 * Hook for component disabled state based on data binding
 */
export function useA2UIDisabled(disabled?: boolean | { path: string }): boolean {
  const { resolveBoolean } = useA2UIData()

  if (disabled === undefined) {
    return false
  }

  return resolveBoolean(disabled, false)
}
