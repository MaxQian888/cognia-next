/**
 * Structured condition model shared by `flow.branch` and `flow.switch`
 * (typeVersion 2). Operands are workflow expression strings (resolved via
 * `lib/workflow/runtime/expression.ts`); evaluation is a pure function in
 * `lib/workflow/runtime/conditions.ts`. There is intentionally NO arbitrary
 * JS eval — operators are a fixed, safe enumeration.
 */

export type WorkflowConditionOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "regex"
  | "inRange"
  | "isEmpty"
  | "isNotEmpty"
  | "truthy"

/** One comparison. `left` (and `right`/`rightUpper`) are expression strings. */
export interface WorkflowCondition {
  /** Left operand — an expression string, e.g. `{{ $node['n1'].field }}`. */
  left: string
  operator: WorkflowConditionOperator
  /** Right operand. Omitted for unary operators (isEmpty/isNotEmpty/truthy). */
  right?: string
  /** Upper bound for `inRange` (inclusive). Ignored by other operators. */
  rightUpper?: string
  /**
   * Case sensitivity for equality / substring / prefix / suffix operators.
   * Defaults to false (case-insensitive) when omitted. Ordering operators
   * (gt/gte/lt/lte) numeric-coerce both operands first, so this is ignored
   * there unless both sides are non-numeric.
   */
  caseSensitive?: boolean
}

export type WorkflowConditionCombinator = "all" | "any"

/** A group of conditions combined with AND (`all`) or OR (`any`). */
export interface WorkflowConditionGroup {
  combinator: WorkflowConditionCombinator
  conditions: WorkflowCondition[]
}

/** Runtime-iterable list of every operator (e.g. for the condition-builder UI). */
export const WORKFLOW_CONDITION_OPERATORS: readonly WorkflowConditionOperator[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "regex",
  "inRange",
  "isEmpty",
  "isNotEmpty",
  "truthy",
] as const
