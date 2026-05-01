/**
 * useA2UIDataModel Hook
 * Provides reactive data model access for A2UI components
 */

import { useMemo, useCallback } from "react"
import { useA2UIStore } from "@/stores/a2ui"
import {
  getValueByPath,
  resolveStringOrPath,
  resolveNumberOrPath,
  resolveBooleanOrPath,
  resolveArrayOrPath,
} from "@/lib/a2ui/data-model"

interface UseA2UIDataModelReturn {
  dataModel: Record<string, unknown>
  getValue: <T = unknown>(path: string) => T | undefined
  setValue: (path: string, value: unknown) => void
  resolveString: (value: string | { path: string }, defaultValue?: string) => string
  resolveNumber: (value: number | { path: string }, defaultValue?: number) => number
  resolveBoolean: (value: boolean | { path: string }, defaultValue?: boolean) => boolean
  resolveArray: <T>(value: T[] | { path: string }, defaultValue?: T[]) => T[]
}

/**
 * Hook for accessing and manipulating A2UI surface data model
 */
export function useA2UIDataModel(surfaceId: string): UseA2UIDataModelReturn {
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])
  const setDataValueStore = useA2UIStore((state) => state.setDataValue)

  const dataModel = useMemo(() => surface?.dataModel ?? {}, [surface])

  // Get value by path
  const getValue = useCallback(
    <T = unknown>(path: string): T | undefined => {
      return getValueByPath<T>(dataModel, path)
    },
    [dataModel]
  )

  // Set value by path
  const setValue = useCallback(
    (path: string, value: unknown) => {
      setDataValueStore(surfaceId, path, value)
    },
    [surfaceId, setDataValueStore]
  )

  // Resolve string or path
  const resolveString = useCallback(
    (value: string | { path: string }, defaultValue: string = ""): string => {
      return resolveStringOrPath(value, dataModel, defaultValue)
    },
    [dataModel]
  )

  // Resolve number or path
  const resolveNumber = useCallback(
    (value: number | { path: string }, defaultValue: number = 0): number => {
      return resolveNumberOrPath(value, dataModel, defaultValue)
    },
    [dataModel]
  )

  // Resolve boolean or path
  const resolveBoolean = useCallback(
    (value: boolean | { path: string }, defaultValue: boolean = false): boolean => {
      return resolveBooleanOrPath(value, dataModel, defaultValue)
    },
    [dataModel]
  )

  // Resolve array or path
  const resolveArray = useCallback(
    <T>(value: T[] | { path: string }, defaultValue: T[] = []): T[] => {
      return resolveArrayOrPath<T>(value, dataModel, defaultValue)
    },
    [dataModel]
  )

  return {
    dataModel,
    getValue,
    setValue,
    resolveString,
    resolveNumber,
    resolveBoolean,
    resolveArray,
  }
}

/**
 * Hook for a single bound value with two-way binding
 */
export function useA2UIBoundValue<T>(
  surfaceId: string,
  path: string,
  defaultValue: T
): [T, (value: T) => void] {
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])
  const setDataValueStore = useA2UIStore((state) => state.setDataValue)

  const value = useMemo(() => {
    if (!surface?.dataModel) return defaultValue
    const result = getValueByPath<T>(surface.dataModel, path)
    return result ?? defaultValue
  }, [surface, path, defaultValue])

  const setValue = useCallback(
    (newValue: T) => {
      setDataValueStore(surfaceId, path, newValue)
    },
    [surfaceId, path, setDataValueStore]
  )

  return [value, setValue]
}

/**
 * Hook for watching multiple paths
 */
export function useA2UIWatchPaths(surfaceId: string, paths: string[]): Record<string, unknown> {
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])

  return useMemo(() => {
    const values: Record<string, unknown> = {}
    if (!surface?.dataModel) return values

    for (const path of paths) {
      values[path] = getValueByPath(surface.dataModel, path)
    }

    return values
  }, [surface, paths])
}

/**
 * Hook for form field binding
 */
export function useA2UIFormField(
  surfaceId: string,
  fieldPath: string,
  options?: {
    defaultValue?: string
    transform?: (value: string) => unknown
    format?: (value: unknown) => string
  }
): {
  value: string
  onChange: (value: string) => void
  onBlur: () => void
} {
  const { defaultValue = "", transform, format } = options ?? {}

  const surface = useA2UIStore((state) => state.surfaces[surfaceId])
  const setDataValueStore = useA2UIStore((state) => state.setDataValue)
  const emitDataChange = useA2UIStore((state) => state.emitDataChange)

  const rawValue = useMemo(() => {
    if (!surface?.dataModel) return defaultValue
    const result = getValueByPath(surface.dataModel, fieldPath)
    if (result === undefined || result === null) return defaultValue
    return format ? format(result) : String(result)
  }, [surface, fieldPath, defaultValue, format])

  const onChange = useCallback(
    (newValue: string) => {
      const transformedValue = transform ? transform(newValue) : newValue
      setDataValueStore(surfaceId, fieldPath, transformedValue)
    },
    [surfaceId, fieldPath, setDataValueStore, transform]
  )

  const onBlur = useCallback(() => {
    // Emit change event on blur for form validation
    const currentValue = surface?.dataModel
      ? getValueByPath(surface.dataModel, fieldPath)
      : undefined
    emitDataChange(surfaceId, fieldPath, currentValue)
  }, [surfaceId, fieldPath, surface, emitDataChange])

  return {
    value: rawValue,
    onChange,
    onBlur,
  }
}
