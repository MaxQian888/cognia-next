/**
 * Declared computed values for A2UI surfaces (ADR-0240).
 *
 * A model cannot hand the host a function, so `ComputedField` (a closure in
 * `data-model.ts`) was never reachable from a generated surface. This module is
 * the serializable side: a surface declares
 *
 *   computed: { "/total": { op: "multiply", args: [{ path: "/qty" }, { path: "/price" }] } }
 *
 * and the host compiles each declaration into a `ComputedField` and runs it
 * through the existing `resolveComputedFields` after every data change, so a
 * loan calculator or a cart total updates as the user types without another
 * agent turn.
 *
 * Safety rests on three properties: the operator set is closed (nothing is
 * evaluated as code), every declaration is bounded in depth and size before it
 * is accepted, and evaluation is a single ordered pass (a declaration may read
 * values computed before it, never itself again), so it always terminates.
 */

import {
  computedHelpers,
  getValueByPath,
  isSafeDataModelKey,
  parseJsonPointer,
  resolveComputedFields,
  type ComputedField,
  type ComputedFieldRegistry,
} from "./data-model"
import type {
  A2UIComputedArg,
  A2UIComputedExpression,
  A2UIComputedFields,
  A2UIComputedFieldsUpdate,
  A2UIComputedOp,
} from "@/types/a2ui/schema"

/** Bounds a declaration must fit before it is accepted. */
export const A2UI_COMPUTED_LIMITS = {
  fields: 64,
  depth: 8,
  args: 32,
  nodes: 256,
  /** Longest string `concat` may produce. Chained declarations could otherwise
   *  multiply a string's length in one pass. */
  text: 10_000,
} as const

/** Operand counts per operator: [min, max]. */
const ARITY: Record<A2UIComputedOp, readonly [number, number]> = {
  add: [1, A2UI_COMPUTED_LIMITS.args],
  subtract: [2, 2],
  multiply: [1, A2UI_COMPUTED_LIMITS.args],
  divide: [2, 2],
  mod: [2, 2],
  pow: [2, 2],
  min: [1, A2UI_COMPUTED_LIMITS.args],
  max: [1, A2UI_COMPUTED_LIMITS.args],
  abs: [1, 1],
  round: [1, 2],
  floor: [1, 1],
  ceil: [1, 1],
  sum: [1, A2UI_COMPUTED_LIMITS.args],
  sumOf: [2, 2],
  count: [1, 1],
  countWhere: [3, 3],
  percentage: [2, 2],
  concat: [2, A2UI_COMPUTED_LIMITS.args],
  currency: [1, 3],
  fixed: [1, 2],
  if: [3, 3],
  eq: [2, 2],
  neq: [2, 2],
  gt: [2, 2],
  gte: [2, 2],
  lt: [2, 2],
  lte: [2, 2],
  and: [1, A2UI_COMPUTED_LIMITS.args],
  or: [1, A2UI_COMPUTED_LIMITS.args],
  not: [1, 1],
}

export const A2UI_COMPUTED_OPS = Object.keys(ARITY) as A2UIComputedOp[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isPathOperand(value: unknown): value is { path: string } {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value.path === "string"
}

/** A JSON Pointer the data model can hold (no prototype keys, not the root). */
export function isComputedTargetPath(path: string): boolean {
  if (!path.startsWith("/") || path === "/") return false
  try {
    return parseJsonPointer(path).every(isSafeDataModelKey)
  } catch {
    return false
  }
}

function validateArg(value: unknown, depth: number, budget: { nodes: number }): boolean {
  budget.nodes += 1
  if (budget.nodes > A2UI_COMPUTED_LIMITS.nodes) return false
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (isPathOperand(value)) return value.path === "/" || isComputedTargetPath(value.path)
  return validateExpression(value, depth, budget)
}

function validateExpression(value: unknown, depth: number, budget: { nodes: number }): boolean {
  if (!isRecord(value) || depth > A2UI_COMPUTED_LIMITS.depth) return false
  if (Object.keys(value).some((key) => key !== "op" && key !== "args")) return false
  const op = value.op
  if (typeof op !== "string" || !Object.hasOwn(ARITY, op)) return false
  const args = value.args ?? []
  if (!Array.isArray(args)) return false
  const [min, max] = ARITY[op as A2UIComputedOp]
  if (args.length < min || args.length > max) return false
  return args.every((arg) => validateArg(arg, depth + 1, budget))
}

/** Whether `value` is one acceptable computed expression. */
export function isA2UIComputedExpression(value: unknown): value is A2UIComputedExpression {
  return validateExpression(value, 1, { nodes: 0 })
}

/**
 * Validate a declaration map. With `allowRemoval`, a `null` value (remove the
 * declaration at that path) is accepted, as an update message allows.
 */
export function isA2UIComputedFields(
  value: unknown,
  options: { allowRemoval?: boolean } = {}
): value is A2UIComputedFields | A2UIComputedFieldsUpdate {
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  if (entries.length > A2UI_COMPUTED_LIMITS.fields) return false
  const shaped = entries.every(
    ([path, expression]) =>
      isComputedTargetPath(path) &&
      ((options.allowRemoval && expression === null) || isA2UIComputedExpression(expression))
  )
  // An update is checked for order once it is merged into the surface's map.
  return shaped && (options.allowRemoval || isWellOrdered(value as A2UIComputedFields))
}

/**
 * Apply an update to a declaration map: replace by path, `null` removes. An
 * update whose result is not well ordered (see `isWellOrdered`) is dropped and
 * the current map kept.
 */
export function mergeA2UIComputedFields(
  current: A2UIComputedFields | undefined,
  update: A2UIComputedFieldsUpdate
): A2UIComputedFields | undefined {
  const next: A2UIComputedFields = { ...current }
  for (const [path, expression] of Object.entries(update)) {
    if (expression === null) delete next[path]
    else next[path] = expression
  }
  if (Object.keys(next).length > A2UI_COMPUTED_LIMITS.fields || !isWellOrdered(next)) {
    return current
  }
  return Object.keys(next).length > 0 ? next : undefined
}

/** Whether two pointers name the same value or one contains the other. */
function overlaps(a: string, b: string): boolean {
  return a === b || a === "/" || b === "/" || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/**
 * Whether each declaration reads only plain data and the targets declared
 * before it, and no two targets overlap. Reading its own target, or one a
 * later declaration writes, feeds the previous result back in: the value
 * would drift on every data change instead of settling in one pass.
 */
function isWellOrdered(computed: A2UIComputedFields): boolean {
  const targets = Object.keys(computed)
  return targets.every((target, index) => {
    const reads = new Set<string>()
    collectPaths(computed[target], reads)
    const pending = targets.slice(index)
    return (
      targets.slice(index + 1).every((other) => !overlaps(target, other)) &&
      [...reads].every((read) => pending.every((other) => !overlaps(read, other)))
    )
  })
}

// =============================================================================
// Evaluation
// =============================================================================

function collectPaths(arg: A2UIComputedArg, into: Set<string>): void {
  if (isPathOperand(arg)) into.add(arg.path)
  else if (isRecord(arg)) {
    for (const child of (arg as A2UIComputedExpression).args ?? []) collectPaths(child, into)
  }
}

/**
 * A number from a data value: text fields hold strings, so `"12"` is 12 and
 * an empty field is 0. Anything else non-numeric is NaN, which makes the whole
 * result `null` rather than a misleading number.
 */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "boolean") return value ? 1 : 0
  if (value === null || value === undefined) return 0
  if (typeof value === "string") return value.trim() === "" ? 0 : Number(value)
  return Number.NaN
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return Boolean(value)
}

function flatNumbers(values: unknown[]): number[] {
  return values.flatMap((value) => (Array.isArray(value) ? value : [value])).map(toNumber)
}

function evaluateArg(arg: A2UIComputedArg, read: (path: string) => unknown): unknown {
  if (isPathOperand(arg)) return read(arg.path)
  if (isRecord(arg)) return evaluateA2UIComputedExpression(arg as A2UIComputedExpression, read)
  return arg
}

/**
 * Evaluate one validated expression against a path reader. Numeric results
 * that are not finite (0/0, a non-numeric input) evaluate to `null`.
 */
export function evaluateA2UIComputedExpression(
  expression: A2UIComputedExpression,
  read: (path: string) => unknown
): unknown {
  const args = expression.args ?? []
  // Lazy operands for the branching operators.
  if (expression.op === "if") {
    return truthy(evaluateArg(args[0], read))
      ? evaluateArg(args[1], read)
      : evaluateArg(args[2], read)
  }
  if (expression.op === "and") return args.every((arg) => truthy(evaluateArg(arg, read)))
  if (expression.op === "or") return args.some((arg) => truthy(evaluateArg(arg, read)))

  const values = args.map((arg) => evaluateArg(arg, read))
  const numbers = () => values.map(toNumber)

  switch (expression.op) {
    case "add":
      return finite(numbers().reduce((acc, n) => acc + n, 0))
    case "subtract":
      return finite(toNumber(values[0]) - toNumber(values[1]))
    case "multiply":
      return finite(numbers().reduce((acc, n) => acc * n, 1))
    case "divide":
      return finite(toNumber(values[0]) / toNumber(values[1]))
    case "mod":
      return finite(toNumber(values[0]) % toNumber(values[1]))
    case "pow":
      return finite(toNumber(values[0]) ** toNumber(values[1]))
    case "min":
      return finite(Math.min(...flatNumbers(values)))
    case "max":
      return finite(Math.max(...flatNumbers(values)))
    case "abs":
      return finite(Math.abs(toNumber(values[0])))
    case "round": {
      const decimals = Math.max(0, Math.min(10, Math.trunc(toNumber(values[1] ?? 0))))
      const factor = 10 ** decimals
      return finite(Math.round(toNumber(values[0]) * factor) / factor)
    }
    case "floor":
      return finite(Math.floor(toNumber(values[0])))
    case "ceil":
      return finite(Math.ceil(toNumber(values[0])))
    case "sum":
      return finite(flatNumbers(values).reduce((acc, n) => acc + n, 0))
    case "sumOf": {
      const [items, field] = values
      if (!Array.isArray(items) || typeof field !== "string") return 0
      return finite(
        items.reduce<number>(
          (acc, item) => acc + toNumber(isRecord(item) ? item[field] : undefined),
          0
        )
      )
    }
    case "count":
      return computedHelpers.count("").compute(values[0])
    case "countWhere": {
      const [items, field, expected] = values
      if (typeof field !== "string") return 0
      return computedHelpers
        .countWhere("", (item) => isRecord(item) && item[field] === expected)
        .compute(items)
    }
    case "percentage":
      return computedHelpers.percentage("", "").compute(values[0], values[1])
    case "concat": {
      // args[0] is the separator; empty parts are skipped.
      const separator = stringify(values[0])
      const parts = values.slice(1).map(stringify)
      const length = parts.reduce((total, part) => total + part.length + separator.length, 0)
      if (length > A2UI_COMPUTED_LIMITS.text + separator.length) return null
      return computedHelpers.concat(separator).compute(...parts)
    }
    case "currency": {
      const symbol = typeof values[1] === "string" ? values[1] : "$"
      const decimals = Math.max(0, Math.min(10, Math.trunc(toNumber(values[2] ?? 2))))
      const amount = toNumber(values[0])
      if (!Number.isFinite(amount)) return null
      return computedHelpers.currency("", symbol, decimals).compute(amount)
    }
    case "fixed": {
      const decimals = Math.max(0, Math.min(10, Math.trunc(toNumber(values[1] ?? 0))))
      const amount = toNumber(values[0])
      return Number.isFinite(amount) ? amount.toFixed(decimals) : null
    }
    case "eq":
      return values[0] === values[1]
    case "neq":
      return values[0] !== values[1]
    case "gt":
      return toNumber(values[0]) > toNumber(values[1])
    case "gte":
      return toNumber(values[0]) >= toNumber(values[1])
    case "lt":
      return toNumber(values[0]) < toNumber(values[1])
    case "lte":
      return toNumber(values[0]) <= toNumber(values[1])
    case "not":
      return !truthy(values[0])
  }
  return null
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

/** Compile declarations into the registry `resolveComputedFields` runs. */
export function compileA2UIComputedFields(computed: A2UIComputedFields): ComputedFieldRegistry {
  const registry: ComputedFieldRegistry = {}
  for (const [target, expression] of Object.entries(computed)) {
    const deps = new Set<string>()
    collectPaths(expression, deps)
    const depList = [...deps]
    const field: ComputedField = {
      deps: depList,
      compute: (...values) => {
        const byPath = new Map(depList.map((path, index) => [path, values[index]]))
        return evaluateA2UIComputedExpression(expression, (path) => byPath.get(path))
      },
    }
    registry[target] = field
  }
  return registry
}

/**
 * The data model with every declared value recomputed, in declaration order.
 * Returns the input unchanged when nothing is declared.
 */
export function applyA2UIComputedFields(
  dataModel: Record<string, unknown>,
  computed: A2UIComputedFields | undefined
): Record<string, unknown> {
  if (!computed || Object.keys(computed).length === 0) return dataModel
  const next = resolveComputedFields(dataModel, compileA2UIComputedFields(computed))
  // Unchanged results keep the previous references, so bound components that
  // compare by identity do not re-render for nothing.
  for (const target of Object.keys(computed)) {
    if (Object.is(getValueByPath(next, target), getValueByPath(dataModel, target))) continue
    return next
  }
  return dataModel
}
