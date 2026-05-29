/**
 * A2UI Context Type Definitions
 * Types for the A2UI React context system (actions + data contexts)
 */

import type React from "react"
import type { A2UISurfaceState, A2UIComponent, A2UIComponentCatalog } from "@/types/artifact/a2ui"

/**
 * Stable actions context — references rarely change
 */
export interface A2UIActionsContextValue {
  surfaceId: string
  catalog: A2UIComponentCatalog | undefined
  emitAction: (action: string, componentId: string, data?: Record<string, unknown>) => void
  setDataValue: (path: string, value: unknown) => void
  getBindingPath: (value: unknown) => string | null
  getComponent: (componentId: string) => A2UIComponent | undefined
  renderChild: (componentId: string) => React.ReactNode
}

/**
 * Data context — changes when surface data/components update
 */
export interface A2UIDataContextValue {
  surface: A2UISurfaceState | null
  dataModel: Record<string, unknown>
  components: Record<string, A2UIComponent>
  resolveString: (value: string | { path: string }, defaultValue?: string) => string
  resolveNumber: (value: number | { path: string }, defaultValue?: number) => number
  resolveBoolean: (value: boolean | { path: string }, defaultValue?: boolean) => boolean
  resolveArray: <T>(value: T[] | { path: string }, defaultValue?: T[]) => T[]
}

/**
 * Combined context value (backward-compatible)
 */
export interface A2UIContextValue extends A2UIActionsContextValue, A2UIDataContextValue {}

/**
 * Props for A2UI Provider
 */
export interface A2UIProviderProps {
  surfaceId: string
  catalogId?: string
  children: React.ReactNode
  renderComponent: (component: A2UIComponent) => React.ReactNode
  /**
   * When true, user actions are inert: `emitAction` and `setDataValue` become
   * no-ops so a surface can be rendered as a read-only preview (e.g. the public
   * share viewer). Defaults to false — the editable/interactive behavior.
   */
  readOnly?: boolean
}
