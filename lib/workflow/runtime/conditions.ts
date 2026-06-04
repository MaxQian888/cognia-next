/**
 * Pure evaluation of the structured condition language (`flow.branch` /
 * `flow.switch` typeVersion 2 — see `types/workflow/conditions.ts`).
 *
 * Operand strings are authored as workflow expressions, but by the time an
 * executor runs them they have already been resolved to typed values by
 * `resolveDeep` (the step executor resolves the whole `params` tree before
 * invoking the node). So this module receives RESOLVED operands (`unknown`),
 * not expression strings, and stays a side-effect-free truth table:
 *
 *   • Ordering operators (gt/gte/lt/lte) numeric-coerce both operands when
 *     possible; otherwise they fall back to a locale-aware string compare.
 *   • eq/neq numeric-coerce when either side is a number, deep-compare
 *     objects/arrays, and honor `caseSensitive` for string pairs
 *     (default: case-insensitive).
 *   • There is intentionally NO `eval` — operators are a closed enumeration.
 */

import type {
  WorkflowConditionCombinator,
  WorkflowConditionOperator,
} from "@/types/workflow/conditions"

/**
 * A condition whose operands have been resolved from expression strings to
 * typed values. Field names mirror `WorkflowCondition`.
 */
export interface ResolvedCondition {
  left: unknown
  operator: WorkflowConditionOperator
  right?: unknown
  rightUpper?: unknown
  caseSensitive?: boolean
}

export interface ResolvedConditionGroup {
  combinator: WorkflowConditionCombinator
  conditions: ResolvedCondition[]
}

/** AND (`all`) / OR (`any`) over the group. Empty: `all` → true, `any` → false. */
export function evaluateConditionGroup(group: ResolvedConditionGroup): boolean {
  if (group.combinator === "any") {
    return group.conditions.some(evaluateCondition)
  }
  return group.conditions.every(evaluateCondition)
}

export function evaluateCondition(cond: ResolvedCondition): boolean {
  const { left, operator, right, rightUpper, caseSensitive } = cond
  switch (operator) {
    case "eq":
      return looseEquals(left, right, caseSensitive === true)
    case "neq":
      return !looseEquals(left, right, caseSensitive === true)
    case "gt":
      return order(left, right, (c) => c > 0)
    case "gte":
      return order(left, right, (c) => c >= 0)
    case "lt":
      return order(left, right, (c) => c < 0)
    case "lte":
      return order(left, right, (c) => c <= 0)
    case "contains":
      return contains(left, right, caseSensitive === true)
    case "notContains":
      return !contains(left, right, caseSensitive === true)
    case "startsWith":
      return affix(left, right, caseSensitive === true, "start")
    case "endsWith":
      return affix(left, right, caseSensitive === true, "end")
    case "regex":
      return regexTest(left, right, caseSensitive === true)
    case "inRange":
      return inRange(left, right, rightUpper)
    case "isEmpty":
      return isEmpty(left)
    case "isNotEmpty":
      return !isEmpty(left)
    case "truthy":
      return isTruthy(left)
    default:
      // Unknown operator (corrupt / future JSON) — fail closed.
      return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

/** Coerce to a finite number, or null when not numeric. */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  if (typeof v === "boolean") return v ? 1 : 0
  return null
}

function looseEquals(a: unknown, b: unknown, caseSensitive: boolean): boolean {
  if (a === b) return true
  // Numeric coercion when either side is a number ("5" eq 5).
  if (typeof a === "number" || typeof b === "number") {
    const na = toFiniteNumber(a)
    const nb = toFiniteNumber(b)
    if (na !== null && nb !== null) return na === nb
  }
  if (typeof a === "string" && typeof b === "string") {
    return caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase()
  }
  // Boolean vs "true"/"false" strings (common after expression resolution).
  if (typeof a === "boolean" || typeof b === "boolean") {
    return asBooleanWord(a) !== null && asBooleanWord(a) === asBooleanWord(b)
  }
  // Structures — order-sensitive deep equality via canonical JSON.
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  return false
}

function asBooleanWord(v: unknown): boolean | null {
  if (typeof v === "boolean") return v
  if (typeof v === "string") {
    const s = v.trim().toLowerCase()
    if (s === "true") return true
    if (s === "false") return false
  }
  return null
}

/** Ordering compare: numeric when both coerce, else locale string compare. */
function order(a: unknown, b: unknown, test: (cmp: number) => boolean): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return false
  const na = toFiniteNumber(a)
  const nb = toFiniteNumber(b)
  if (na !== null && nb !== null) {
    return test(na === nb ? 0 : na < nb ? -1 : 1)
  }
  const sa = String(a)
  const sb = String(b)
  return test(sa.localeCompare(sb))
}

function contains(left: unknown, right: unknown, caseSensitive: boolean): boolean {
  if (Array.isArray(left)) {
    return left.some((item) => looseEquals(item, right, caseSensitive))
  }
  if (left === undefined || left === null || right === undefined || right === null) return false
  const hay = String(left)
  const needle = String(right)
  return caseSensitive ? hay.includes(needle) : hay.toLowerCase().includes(needle.toLowerCase())
}

function affix(
  left: unknown,
  right: unknown,
  caseSensitive: boolean,
  which: "start" | "end"
): boolean {
  if (left === undefined || left === null || right === undefined || right === null) return false
  let hay = String(left)
  let part = String(right)
  if (!caseSensitive) {
    hay = hay.toLowerCase()
    part = part.toLowerCase()
  }
  return which === "start" ? hay.startsWith(part) : hay.endsWith(part)
}

function regexTest(left: unknown, pattern: unknown, caseSensitive: boolean): boolean {
  if (typeof pattern !== "string" || pattern === "") return false
  if (left === undefined || left === null) return false
  try {
    const re = new RegExp(pattern, caseSensitive ? "" : "i")
    return re.test(String(left))
  } catch {
    // Invalid pattern — fail closed rather than crash the run.
    return false
  }
}

function inRange(left: unknown, lower: unknown, upper: unknown): boolean {
  const v = toFiniteNumber(left)
  const lo = toFiniteNumber(lower)
  const hi = toFiniteNumber(upper)
  if (v === null || lo === null || hi === null) return false
  return v >= lo && v <= hi
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === "string") return v === ""
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === "object") return Object.keys(v).length === 0
  return false
}

/**
 * Truthiness with the workflow convention that the literal strings "false"
 * and "0" are false (params arrive stringly-typed from expression concat).
 * Mirrors `isTruthy` in `lib/workflow/nodes/built-ins.ts`.
 */
function isTruthy(v: unknown): boolean {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase()
    if (s === "" || s === "false" || s === "0") return false
    return true
  }
  return Boolean(v)
}
