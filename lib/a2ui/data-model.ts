/**
 * A2UI Data Model and JSON Pointer Binding
 * Implements RFC 6901 JSON Pointer for data binding
 */

import type {
  A2UIPathValue,
  A2UIStringOrPath,
  A2UINumberOrPath,
  A2UIBooleanOrPath,
  A2UIArrayOrPath,
} from "@/types/a2ui/schema"

/**
 * Parse a JSON Pointer string into path segments
 * RFC 6901: https://datatracker.ietf.org/doc/html/rfc6901
 */
export function parseJsonPointer(pointer: string): string[] {
  if (!pointer) {
    return []
  }

  // Root reference
  if (pointer === "/") {
    return []
  }

  // Must start with /
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer: must start with '/' - got "${pointer}"`)
  }

  // Split and decode
  return pointer
    .substring(1)
    .split("/")
    .map((segment) => {
      // Unescape ~1 -> / and ~0 -> ~
      return segment.replace(/~1/g, "/").replace(/~0/g, "~")
    })
}

/**
 * Encode a path segment for JSON Pointer
 */
export function encodeJsonPointerSegment(segment: string): string {
  // Escape ~ -> ~0 and / -> ~1
  return segment.replace(/~/g, "~0").replace(/\//g, "~1")
}

/**
 * Create a JSON Pointer string from path segments
 */
export function createJsonPointer(segments: string[]): string {
  if (segments.length === 0) {
    return "/"
  }
  return "/" + segments.map(encodeJsonPointerSegment).join("/")
}

/**
 * Get a value from an object using a JSON Pointer path
 */
export function getValueByPath<T = unknown>(
  obj: Record<string, unknown>,
  pointer: string
): T | undefined {
  if (!pointer || pointer === "/") {
    return obj as T
  }

  try {
    const segments = parseJsonPointer(pointer)
    let current: unknown = obj

    for (const segment of segments) {
      if (current === null || current === undefined) {
        return undefined
      }

      if (Array.isArray(current)) {
        const index = parseInt(segment, 10)
        if (isNaN(index) || index < 0 || index >= current.length) {
          return undefined
        }
        current = current[index]
      } else if (typeof current === "object") {
        current = (current as Record<string, unknown>)[segment]
      } else {
        return undefined
      }
    }

    return current as T
  } catch {
    return undefined
  }
}

/**
 * Set a value in an object using a JSON Pointer path
 * Creates intermediate objects/arrays as needed
 */
export function setValueByPath(
  obj: Record<string, unknown>,
  pointer: string,
  value: unknown
): Record<string, unknown> {
  if (!pointer || pointer === "/") {
    // Replace entire object
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
    return obj
  }

  const segments = parseJsonPointer(pointer)
  const result = deepClone(obj)
  let current: Record<string, unknown> | unknown[] = result

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]
    const nextSegment = segments[i + 1]
    const isNextArray = /^\d+$/.test(nextSegment)

    if (Array.isArray(current)) {
      const index = parseInt(segment, 10)
      if (current[index] === undefined || current[index] === null) {
        current[index] = isNextArray ? [] : {}
      }
      current = current[index] as Record<string, unknown> | unknown[]
    } else {
      if (current[segment] === undefined || current[segment] === null) {
        current[segment] = isNextArray ? [] : {}
      }
      current = current[segment] as Record<string, unknown> | unknown[]
    }
  }

  const lastSegment = segments[segments.length - 1]
  if (Array.isArray(current)) {
    const index = parseInt(lastSegment, 10)
    current[index] = value
  } else {
    current[lastSegment] = value
  }

  return result
}

/**
 * Delete a value from an object using a JSON Pointer path
 */
export function deleteValueByPath(
  obj: Record<string, unknown>,
  pointer: string
): Record<string, unknown> {
  if (!pointer || pointer === "/") {
    return {}
  }

  const segments = parseJsonPointer(pointer)
  const result = deepClone(obj)
  let current: Record<string, unknown> | unknown[] = result

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]

    if (Array.isArray(current)) {
      const index = parseInt(segment, 10)
      if (current[index] === undefined) {
        return result // Path doesn't exist
      }
      current = current[index] as Record<string, unknown> | unknown[]
    } else {
      if (current[segment] === undefined) {
        return result // Path doesn't exist
      }
      current = current[segment] as Record<string, unknown> | unknown[]
    }
  }

  const lastSegment = segments[segments.length - 1]
  if (Array.isArray(current)) {
    const index = parseInt(lastSegment, 10)
    current.splice(index, 1)
  } else {
    delete current[lastSegment]
  }

  return result
}

/**
 * Deep clone an object
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => deepClone(item)) as T
  }

  const result: Record<string, unknown> = {}
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = deepClone((obj as Record<string, unknown>)[key])
    }
  }
  return result as T
}

/**
 * Merge two objects deeply
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = deepClone(target)

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key]
      const targetValue = result[key]

      if (
        sourceValue &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        result[key] = deepMerge(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>
        )
      } else {
        result[key] = deepClone(sourceValue)
      }
    }
  }

  return result
}

/**
 * Check if a value is a path reference
 */
export function isPathValue<T>(value: T | A2UIPathValue<T>): value is A2UIPathValue<T> {
  return typeof value === "object" && value !== null && "path" in value
}

/**
 * Resolve a string-or-path value against the data model
 */
export function resolveStringOrPath(
  value: A2UIStringOrPath,
  dataModel: Record<string, unknown>,
  defaultValue: string = ""
): string {
  if (typeof value === "string") {
    return value
  }
  if (isPathValue(value)) {
    const resolved = getValueByPath<string>(dataModel, value.path)
    return resolved !== undefined ? String(resolved) : defaultValue
  }
  return defaultValue
}

/**
 * Resolve a number-or-path value against the data model
 */
export function resolveNumberOrPath(
  value: A2UINumberOrPath,
  dataModel: Record<string, unknown>,
  defaultValue: number = 0
): number {
  if (typeof value === "number") {
    return value
  }
  if (isPathValue(value)) {
    const resolved = getValueByPath<number>(dataModel, value.path)
    return typeof resolved === "number" ? resolved : defaultValue
  }
  return defaultValue
}

/**
 * Resolve a boolean-or-path value against the data model
 */
export function resolveBooleanOrPath(
  value: A2UIBooleanOrPath,
  dataModel: Record<string, unknown>,
  defaultValue: boolean = false
): boolean {
  if (typeof value === "boolean") {
    return value
  }
  if (isPathValue(value)) {
    const resolved = getValueByPath<boolean>(dataModel, value.path)
    return typeof resolved === "boolean" ? resolved : defaultValue
  }
  return defaultValue
}

/**
 * Resolve an array-or-path value against the data model
 */
export function resolveArrayOrPath<T>(
  value: A2UIArrayOrPath<T>,
  dataModel: Record<string, unknown>,
  defaultValue: T[] = []
): T[] {
  if (Array.isArray(value)) {
    return value
  }
  if (isPathValue(value)) {
    const resolved = getValueByPath<T[]>(dataModel, value.path)
    return Array.isArray(resolved) ? resolved : defaultValue
  }
  return defaultValue
}

/**
 * Get the path from a path-or-value for two-way binding
 */
export function getBindingPath<T>(value: T | A2UIPathValue<T>): string | null {
  if (isPathValue(value)) {
    return value.path
  }
  return null
}

/**
 * Create a relative path resolver for template/list contexts
 */
export function createRelativePathResolver(
  basePath: string,
  itemIndex: number
): (relativePath: string, dataModel: Record<string, unknown>) => unknown {
  return (relativePath: string, dataModel: Record<string, unknown>) => {
    // If path starts with /, it's absolute
    if (relativePath.startsWith("/")) {
      return getValueByPath(dataModel, relativePath)
    }

    // Otherwise, resolve relative to base path + item index
    const absolutePath = `${basePath}/${itemIndex}/${relativePath}`
    return getValueByPath(dataModel, absolutePath)
  }
}

/**
 * Watch for changes to specific paths in the data model
 */
export interface PathWatcher {
  path: string
  callback: (newValue: unknown, oldValue: unknown) => void
}

export function watchPaths(
  watchers: PathWatcher[],
  oldModel: Record<string, unknown>,
  newModel: Record<string, unknown>
): void {
  for (const watcher of watchers) {
    const oldValue = getValueByPath(oldModel, watcher.path)
    const newValue = getValueByPath(newModel, watcher.path)

    if (!isEqual(oldValue, newValue)) {
      watcher.callback(newValue, oldValue)
    }
  }
}

/**
 * Simple deep equality check
 */
function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false

  if (typeof a === "object") {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false
      return a.every((item, index) => isEqual(item, b[index]))
    }

    if (!Array.isArray(a) && !Array.isArray(b)) {
      const keysA = Object.keys(a as object)
      const keysB = Object.keys(b as object)
      if (keysA.length !== keysB.length) return false
      return keysA.every((key) =>
        isEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
      )
    }
  }

  return false
}

// =============================================================================
// Computed Data Model
// =============================================================================

/**
 * A computed field definition — derives a value from other data model paths
 */
export interface ComputedField {
  /** Paths this computed field depends on */
  deps: string[]
  /** Compute function receiving resolved dependency values */
  compute: (...values: unknown[]) => unknown
}

/**
 * Registry of computed fields for a surface
 */
export type ComputedFieldRegistry = Record<string, ComputedField>

/**
 * Resolve all computed fields and merge them into the data model.
 * Returns a new data model object with computed values applied.
 */
export function resolveComputedFields(
  dataModel: Record<string, unknown>,
  computedFields: ComputedFieldRegistry
): Record<string, unknown> {
  const result = { ...dataModel }

  for (const [path, field] of Object.entries(computedFields)) {
    try {
      const depValues = field.deps.map((dep) => getValueByPath(result, dep))
      const computedValue = field.compute(...depValues)
      // Apply computed value using path segments
      const segments = path.split("/").filter(Boolean)
      if (segments.length === 1) {
        result[segments[0]] = computedValue
      } else {
        // Use setValueByPath for nested paths
        const updated = setValueByPath(result, path, computedValue)
        Object.assign(result, updated)
      }
    } catch {
      // Silently skip failed computations
    }
  }

  return result
}

/**
 * Create common computed field helpers
 */
export const computedHelpers = {
  /** Sum numeric values at paths */
  sum: (...deps: string[]): ComputedField => ({
    deps,
    compute: (...values) => values.reduce((acc: number, v) => acc + (Number(v) || 0), 0),
  }),

  /** Count items in an array at a path */
  count: (arrayPath: string): ComputedField => ({
    deps: [arrayPath],
    compute: (arr) => (Array.isArray(arr) ? arr.length : 0),
  }),

  /** Count items matching a predicate */
  countWhere: (arrayPath: string, predicate: (item: unknown) => boolean): ComputedField => ({
    deps: [arrayPath],
    compute: (arr) => (Array.isArray(arr) ? arr.filter(predicate).length : 0),
  }),

  /** Format a number as currency */
  currency: (valuePath: string, symbol = "$", decimals = 2): ComputedField => ({
    deps: [valuePath],
    compute: (value) => `${symbol}${(Number(value) || 0).toFixed(decimals)}`,
  }),

  /** Concatenate string values */
  concat: (separator: string, ...deps: string[]): ComputedField => ({
    deps,
    compute: (...values) => values.filter(Boolean).join(separator),
  }),

  /** Percentage: (part / total) * 100 */
  percentage: (partPath: string, totalPath: string): ComputedField => ({
    deps: [partPath, totalPath],
    compute: (part, total) => {
      const p = Number(part) || 0
      const t = Number(total) || 0
      return t > 0 ? Math.round((p / t) * 100) : 0
    },
  }),
}

/**
 * Extract all paths referenced in a component tree
 */
export function extractReferencedPaths(components: { [key: string]: unknown }[]): string[] {
  const paths = new Set<string>()

  function traverse(obj: unknown): void {
    if (!obj || typeof obj !== "object") return

    if ("path" in (obj as object)) {
      const pathValue = (obj as A2UIPathValue<unknown>).path
      if (typeof pathValue === "string") {
        paths.add(pathValue)
      }
    }

    if (Array.isArray(obj)) {
      obj.forEach(traverse)
    } else {
      Object.values(obj as object).forEach(traverse)
    }
  }

  components.forEach(traverse)
  return Array.from(paths)
}
