"use client"

/**
 * A2UI React Context Provider
 * Provides A2UI surface state and actions to child components.
 *
 * Context objects and consumer hooks live in hooks/a2ui/use-a2ui-context.ts.
 * This file only contains the Provider component.
 */

import React, { useCallback, useMemo } from "react"
import { useA2UIStore } from "@/stores/a2ui"
import {
  resolveStringOrPath,
  resolveNumberOrPath,
  resolveBooleanOrPath,
  resolveArrayOrPath,
  getBindingPath,
} from "@/lib/a2ui/data-model"
import { getCatalog, DEFAULT_CATALOG_ID } from "@/lib/a2ui/catalog"
import { loggers } from "@/lib/logging"
import { A2UIActionsCtx, A2UIDataCtx } from "@/hooks/a2ui/use-a2ui-context"
import type { A2UIActionsContextValue, A2UIDataContextValue } from "@/types/a2ui/context"
import type { A2UIProviderProps } from "@/types/a2ui/context"

/**
 * A2UI Context Provider
 */
export function A2UIProvider({
  surfaceId,
  catalogId = DEFAULT_CATALOG_ID,
  children,
  renderComponent,
}: A2UIProviderProps) {
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])
  const emitActionStore = useA2UIStore((state) => state.emitAction)
  const setDataValueStore = useA2UIStore((state) => state.setDataValue)

  const dataModel = useMemo(() => surface?.dataModel ?? {}, [surface])
  const components = useMemo(() => surface?.components ?? {}, [surface])
  const catalog = getCatalog(catalogId)

  const emitAction = useCallback(
    (action: string, componentId: string, data?: Record<string, unknown>) => {
      emitActionStore(surfaceId, action, componentId, data)
    },
    [surfaceId, emitActionStore]
  )

  const setDataValue = useCallback(
    (path: string, value: unknown) => {
      setDataValueStore(surfaceId, path, value)
    },
    [surfaceId, setDataValueStore]
  )

  const resolveString = useCallback(
    (value: string | { path: string }, defaultValue: string = "") => {
      return resolveStringOrPath(value, dataModel, defaultValue)
    },
    [dataModel]
  )

  const resolveNumber = useCallback(
    (value: number | { path: string }, defaultValue: number = 0) => {
      return resolveNumberOrPath(value, dataModel, defaultValue)
    },
    [dataModel]
  )

  const resolveBoolean = useCallback(
    (value: boolean | { path: string }, defaultValue: boolean = false) => {
      return resolveBooleanOrPath(value, dataModel, defaultValue)
    },
    [dataModel]
  )

  const resolveArray = useCallback(
    <T,>(value: T[] | { path: string }, defaultValue: T[] = []) => {
      return resolveArrayOrPath<T>(value, dataModel, defaultValue)
    },
    [dataModel]
  )

  const getComponent = useCallback(
    (componentId: string) => {
      return components[componentId]
    },
    [components]
  )

  const renderChild = useCallback(
    (componentId: string): React.ReactNode => {
      const component = components[componentId]
      if (!component) {
        loggers.ui.warn(`[A2UI] Component not found: ${componentId}`)
        return null
      }
      return renderComponent(component)
    },
    [components, renderComponent]
  )

  // Actions context — stable references
  const actionsValue = useMemo<A2UIActionsContextValue>(
    () => ({
      surfaceId,
      catalog,
      emitAction,
      setDataValue,
      getBindingPath,
      getComponent,
      renderChild,
    }),
    [surfaceId, catalog, emitAction, setDataValue, getComponent, renderChild]
  )

  // Data context — changes with surface state
  const dataValue = useMemo<A2UIDataContextValue>(
    () => ({
      surface: surface ?? null,
      dataModel,
      components,
      resolveString,
      resolveNumber,
      resolveBoolean,
      resolveArray,
    }),
    [surface, dataModel, components, resolveString, resolveNumber, resolveBoolean, resolveArray]
  )

  return (
    <A2UIActionsCtx.Provider value={actionsValue}>
      <A2UIDataCtx.Provider value={dataValue}>{children}</A2UIDataCtx.Provider>
    </A2UIActionsCtx.Provider>
  )
}

// Re-export consumer hooks from their canonical location for backward compatibility
export {
  useA2UIActions,
  useA2UIData,
  useA2UIContext,
  useA2UIComponent,
  useA2UIBinding,
  useA2UIVisibility,
  useA2UIDisabled,
} from "@/hooks/a2ui/use-a2ui-context"
