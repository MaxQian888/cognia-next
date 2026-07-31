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

const UNSAFE_DATA_MODEL_KEYS = new Set(["__proto__", "constructor", "prototype"])

/** Whether a key is addressable and safe under the editor's JSON Pointer contract. */
export function isSafeDataModelKey(key: string): boolean {
  return key.length > 0 && !UNSAFE_DATA_MODEL_KEYS.has(key)
}

/** Narrow an unknown value to a safe, finite, acyclic JSON object data model. */
export function isA2UIDataModel(value: unknown): value is Record<string, unknown> {
  return isJsonDataValue(value, new Set(), true)
}

function isJsonDataValue(value: unknown, ancestors: Set<object>, root = false): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return !root
  if (typeof value === "number") return !root && Number.isFinite(value)
  if (typeof value !== "object" || ancestors.has(value)) return false
  if (root && Array.isArray(value)) return false

  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false
  const nextAncestors = new Set(ancestors).add(value)
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isJsonDataValue(entry, nextAncestors)) return false
    }
    return true
  }

  return Object.entries(value as Record<string, unknown>).every(
    ([key, entry]) => isSafeDataModelKey(key) && isJsonDataValue(entry, nextAncestors)
  )
}

function parseArrayIndex(segment: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(segment)) return null
  const index = Number(segment)
  return Number.isSafeInteger(index) ? index : null
}

function hasUnsafePointerSegment(segments: string[]): boolean {
  return segments.some((segment) => UNSAFE_DATA_MODEL_KEYS.has(segment))
}

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
      if (/~(?![01])/.test(segment)) {
        throw new Error(`Invalid JSON Pointer escape sequence in "${pointer}"`)
      }
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
        const index = parseArrayIndex(segment)
        if (index === null || index >= current.length) {
          return undefined
        }
        current = current[index]
      } else if (typeof current === "object") {
        if (
          !isSafeDataModelKey(segment) ||
          !Object.prototype.hasOwnProperty.call(current, segment)
        ) {
          return undefined
        }
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
 * Narrow an unknown value to a mutable container (object or array).
 */
function isContainerNode(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null
}

/**
 * Set a value in an object using a JSON Pointer path.
 *
 * Uses **structural sharing**: only the spine from the root to the mutated
 * node is copied; every sibling subtree keeps its original reference. This
 * keeps mutations O(depth) instead of O(model size) AND lets `getValueByPath`
 * return referentially-identical results for untouched paths — the property
 * the renderer relies on to skip re-rendering components whose bound data did
 * not change. Setting a value `Object.is`-equal to the existing one returns
 * the original object unchanged (no-op, no new identity).
 *
 * Creates intermediate objects/arrays as needed (array when the next segment
 * is a numeric index, object otherwise), mirroring the prior deep-clone
 * implementation's path-creation behavior.
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
  if (hasUnsafePointerSegment(segments)) return obj
  return setInNode(obj, segments, 0, value) as Record<string, unknown>
}

function setInNode(node: unknown, segments: string[], index: number, value: unknown): unknown {
  const segment = segments[index]
  const isLast = index === segments.length - 1

  if (Array.isArray(node)) {
    const arrIndex = parseArrayIndex(segment)
    if (arrIndex === null) return node
    if (isLast) {
      if (arrIndex >= 0 && arrIndex < node.length && Object.is(node[arrIndex], value)) {
        return node
      }
      const copy = node.slice()
      copy[arrIndex] = value
      return copy
    }
    const nextIsArray = /^\d+$/.test(segments[index + 1])
    const child = node[arrIndex]
    const childContainer = isContainerNode(child) ? child : nextIsArray ? [] : {}
    const newChild = setInNode(childContainer, segments, index + 1, value)
    if (Object.is(newChild, node[arrIndex])) return node
    const copy = node.slice()
    copy[arrIndex] = newChild
    return copy
  }

  // Coerce non-container nodes to an object so a binding can create the path.
  const objNode = isContainerNode(node) ? (node as Record<string, unknown>) : {}
  if (isLast) {
    if (
      Object.prototype.hasOwnProperty.call(objNode, segment) &&
      Object.is(objNode[segment], value)
    ) {
      return node
    }
    const copy = { ...objNode }
    copy[segment] = value
    return copy
  }
  const nextIsArray = /^\d+$/.test(segments[index + 1])
  const child = objNode[segment]
  const childContainer = isContainerNode(child) ? child : nextIsArray ? [] : {}
  const newChild = setInNode(childContainer, segments, index + 1, value)
  if (Object.is(newChild, objNode[segment])) return node
  const copy = { ...objNode }
  copy[segment] = newChild
  return copy
}

/**
 * Delete a value from an object using a JSON Pointer path.
 *
 * Structural-sharing counterpart to {@link setValueByPath}: only the spine to
 * the deleted node is copied, and a path that does not exist returns the
 * original object unchanged (preserving identity for no-op deletes).
 */
export function deleteValueByPath(
  obj: Record<string, unknown>,
  pointer: string
): Record<string, unknown> {
  if (!pointer || pointer === "/") {
    return {}
  }

  const segments = parseJsonPointer(pointer)
  if (hasUnsafePointerSegment(segments)) return obj
  return deleteInNode(obj, segments, 0) as Record<string, unknown>
}

function deleteInNode(node: unknown, segments: string[], index: number): unknown {
  if (!isContainerNode(node)) return node // Path doesn't exist — unchanged.
  const segment = segments[index]
  const isLast = index === segments.length - 1

  if (Array.isArray(node)) {
    const arrIndex = parseArrayIndex(segment)
    if (arrIndex === null || arrIndex >= node.length) return node
    if (isLast) {
      const copy = node.slice()
      copy.splice(arrIndex, 1)
      return copy
    }
    const newChild = deleteInNode(node[arrIndex], segments, index + 1)
    if (Object.is(newChild, node[arrIndex])) return node
    const copy = node.slice()
    copy[arrIndex] = newChild
    return copy
  }

  const objNode = node as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(objNode, segment)) return node
  if (isLast) {
    const copy = { ...objNode }
    delete copy[segment]
    return copy
  }
  const newChild = deleteInNode(objNode[segment], segments, index + 1)
  if (Object.is(newChild, objNode[segment])) return node
  const copy = { ...objNode }
  copy[segment] = newChild
  return copy
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
  let changed = false
  const result: Record<string, unknown> = { ...target }

  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue

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
      const merged = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      )
      // Structural sharing: only replace (and flag a change) when the nested
      // merge actually produced a new subtree, so untouched branches keep
      // their original reference.
      if (!Object.is(merged, targetValue)) {
        result[key] = merged
        changed = true
      }
    } else if (!Object.is(targetValue, sourceValue)) {
      // `source` is an inbound message payload the store treats as immutable;
      // clone it so the merged model never aliases the message object.
      result[key] = deepClone(sourceValue)
      changed = true
    }
  }

  // Return the original target untouched when the source introduced nothing
  // new — preserves identity so downstream memoization can short-circuit.
  return changed ? result : target
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

/**
 * Component fields that carry a JSON Pointer as a **plain string** (not a
 * `{ path }` PathValue object), and therefore are invisible to
 * {@link extractReferencedPaths}. A component that reads the data model
 * through one of these fields still needs to re-render when that data
 * changes, so the renderer's change-detection must include them.
 *
 * Kept in sync with `types/a2ui/schema.ts`:
 *   - `dataPath`           — List template array source
 *   - `sortKeyPath` /
 *     `sortDirectionPath`  — Table / explorer path-bound sort state
 *   - `currentStepPath`    — Stepper current-step binding
 */
const STRING_POINTER_FIELDS = [
  "dataPath",
  "sortKeyPath",
  "sortDirectionPath",
  "currentStepPath",
] as const

/**
 * Collect every data-model path a single component reads — the union of
 * `{ path }` PathValue references and the plain-string pointer fields listed
 * in {@link STRING_POINTER_FIELDS}. The renderer resolves these paths against
 * the data model to decide whether a component's bound data actually changed
 * (see `useBoundDataVersion`), so under-collecting would cause a component to
 * miss a legitimate update — the collector is deliberately conservative.
 */
export function collectComponentDataPaths(component: unknown): string[] {
  const paths = new Set<string>(extractReferencedPaths([component as { [key: string]: unknown }]))

  const traverse = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return
    if (!Array.isArray(obj)) {
      for (const field of STRING_POINTER_FIELDS) {
        const value = (obj as Record<string, unknown>)[field]
        if (typeof value === "string" && value) {
          paths.add(value)
        }
      }
    }
    if (Array.isArray(obj)) {
      obj.forEach(traverse)
    } else {
      Object.values(obj as object).forEach(traverse)
    }
  }

  traverse(component)
  return Array.from(paths)
}
