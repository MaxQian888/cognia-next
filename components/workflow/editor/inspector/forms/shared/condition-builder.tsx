"use client"

/**
 * Structured condition group editor — the shared field-operator-value row
 * builder used by the `flow.branch` / `flow.switch` (typeVersion 2) inspector
 * forms. Edits a `WorkflowConditionGroup` (types/workflow/conditions.ts):
 * an AND/OR combinator over rows of `left <operator> right`.
 *
 * Operands are workflow expressions (the runtime resolves them via
 * `resolveDeep` before evaluation), so `left`/`right` reuse the
 * expression-field with node-output completions.
 */

import { useTranslations } from "next-intl"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  WORKFLOW_CONDITION_OPERATORS,
  type WorkflowCondition,
  type WorkflowConditionGroup,
  type WorkflowConditionOperator,
} from "@/types/workflow/conditions"
import { ExpressionField } from "./expression-field"

/** Operators with no right operand. */
const UNARY_OPERATORS: ReadonlySet<WorkflowConditionOperator> = new Set([
  "isEmpty",
  "isNotEmpty",
  "truthy",
])

/** Operators where the case-sensitivity toggle applies. */
const CASE_TOGGLE_OPERATORS: ReadonlySet<WorkflowConditionOperator> = new Set([
  "eq",
  "neq",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "regex",
])

const EMPTY_GROUP: WorkflowConditionGroup = { combinator: "all", conditions: [] }

export interface ConditionBuilderProps {
  /** Current group; undefined renders an empty builder. */
  value: WorkflowConditionGroup | undefined
  onChange: (next: WorkflowConditionGroup) => void
  /** Unique prefix for ids/testids when several builders coexist (switch cases). */
  idPrefix: string
  className?: string
}

export function ConditionBuilder({ value, onChange, idPrefix, className }: ConditionBuilderProps) {
  const t = useTranslations("workflows.forms.conditionBuilder")
  const group = value ?? EMPTY_GROUP

  function patchRow(index: number, patch: Partial<WorkflowCondition>) {
    const conditions = group.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c))
    onChange({ ...group, conditions })
  }

  function removeRow(index: number) {
    onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) })
  }

  function addRow() {
    onChange({
      ...group,
      conditions: [...group.conditions, { left: "", operator: "eq", right: "" }],
    })
  }

  return (
    <div className={cn("space-y-2", className)} data-testid={`${idPrefix}-condition-builder`}>
      <div
        role="group"
        aria-label={t("combinator.aria")}
        className="inline-flex rounded-md border p-0.5"
      >
        {(["all", "any"] as const).map((c) => (
          <button
            key={c}
            type="button"
            className={cn(
              "rounded px-2 py-0.5 text-xs",
              group.combinator === c ? "bg-primary text-primary-foreground" : "hover:bg-accent"
            )}
            aria-pressed={group.combinator === c}
            onClick={() => onChange({ ...group, combinator: c })}
            data-testid={`${idPrefix}-combinator-${c}`}
          >
            {t(`combinator.${c}`)}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {group.conditions.map((cond, i) => {
          const unary = UNARY_OPERATORS.has(cond.operator)
          const caseToggle = CASE_TOGGLE_OPERATORS.has(cond.operator)
          const inRange = cond.operator === "inRange"
          return (
            <div key={i} className="space-y-1 rounded-md border p-2">
              <div className="flex items-start gap-2">
                <div className="flex-1" data-testid={`${idPrefix}-left-${i}`}>
                  <ExpressionField
                    id={`${idPrefix}-left-${i}`}
                    value={cond.left}
                    onChange={(v) => patchRow(i, { left: v })}
                    placeholder={t("left.placeholder")}
                    aria-label={t("left.aria")}
                  />
                </div>
                <Select
                  value={cond.operator}
                  onValueChange={(op) => {
                    const operator = op as WorkflowConditionOperator
                    const patch: Partial<WorkflowCondition> = { operator }
                    // Drop fields the new operator can't use so stale state
                    // never leaks into evaluation.
                    if (UNARY_OPERATORS.has(operator)) patch.right = undefined
                    if (operator !== "inRange") patch.rightUpper = undefined
                    if (!CASE_TOGGLE_OPERATORS.has(operator)) patch.caseSensitive = undefined
                    patchRow(i, patch)
                  }}
                >
                  <SelectTrigger
                    className="w-[130px] shrink-0"
                    aria-label={t("operator.aria")}
                    data-testid={`${idPrefix}-operator-${i}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WORKFLOW_CONDITION_OPERATORS.map((op) => (
                      <SelectItem key={op} value={op}>
                        {t(`operators.${op}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => removeRow(i)}
                  aria-label={t("removeCondition")}
                  data-testid={`${idPrefix}-remove-${i}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              {!unary ? (
                <div className="flex items-start gap-2">
                  <div className="flex-1" data-testid={`${idPrefix}-right-${i}`}>
                    <ExpressionField
                      id={`${idPrefix}-right-${i}`}
                      value={cond.right ?? ""}
                      onChange={(v) => patchRow(i, { right: v })}
                      placeholder={t("right.placeholder")}
                      aria-label={t("right.aria")}
                    />
                  </div>
                  {inRange ? (
                    <Input
                      className="w-[120px] shrink-0"
                      value={cond.rightUpper ?? ""}
                      onChange={(e) => patchRow(i, { rightUpper: e.target.value })}
                      placeholder={t("rightUpper.placeholder")}
                      aria-label={t("rightUpper.aria")}
                      data-testid={`${idPrefix}-right-upper-${i}`}
                    />
                  ) : null}
                </div>
              ) : null}
              {caseToggle ? (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox
                    checked={cond.caseSensitive === true}
                    onCheckedChange={(checked) =>
                      patchRow(i, { caseSensitive: checked === true ? true : undefined })
                    }
                    data-testid={`${idPrefix}-case-sensitive-${i}`}
                  />
                  {t("caseSensitive")}
                </label>
              ) : null}
            </div>
          )
        })}
      </div>

      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={addRow}
        data-testid={`${idPrefix}-add-condition`}
      >
        <Plus className="size-3.5 mr-1" /> {t("addCondition")}
      </Button>
      <p className="text-[11px] text-muted-foreground" data-testid={`${idPrefix}-coercion-hint`}>
        {t("coercionHint")}
      </p>
    </div>
  )
}
