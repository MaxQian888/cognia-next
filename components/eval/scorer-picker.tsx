"use client"

/**
 * Scorer selector grouped by evaluation dimension — shared by the run-config
 * dialog and the eval settings "default scorers" card. Renders one collapsible
 * group per dimension with a group-level select-all, a per-scorer checkbox, and
 * an LLM badge on the judge / RAG-generation scorers. When no judge client is
 * available those scorers are shown disabled so the user understands why their
 * verdict won't appear.
 *
 * The picker always operates on an EXPLICIT set of checked ids (never the
 * "empty = all" engine encoding); callers normalize at the boundary via
 * {@link normalizeScorerSelection} / {@link expandScorerSelection}.
 */

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { EvalDimension } from "@/types/eval/eval"
import {
  ALL_SCORER_IDS,
  SCORER_DIMENSIONS,
  scorersForDimension,
  type ScorerCatalogEntry,
} from "@/lib/ai/eval/scorers/catalog"

/** `[]` (all) → the explicit full id list; any other list passes through. */
export function expandScorerSelection(ids: readonly string[]): string[] {
  return ids.length === 0 ? [...ALL_SCORER_IDS] : [...ids]
}

/** Full selection → `[]` (the engine's "all" sentinel); otherwise passes through. */
export function normalizeScorerSelection(ids: readonly string[]): string[] {
  const set = new Set(ids)
  const isAll = ALL_SCORER_IDS.every((id) => set.has(id)) && set.size === ALL_SCORER_IDS.length
  return isAll ? [] : ALL_SCORER_IDS.filter((id) => set.has(id))
}

export interface ScorerPickerProps {
  /** Explicit checked ids (use {@link expandScorerSelection} for the store value). */
  value: string[]
  onChange: (next: string[]) => void
  /** When false, the `requiresLlm` scorers are shown disabled (no judge client). */
  judgeAvailable?: boolean
  className?: string
}

export function ScorerPicker({
  value,
  onChange,
  judgeAvailable = true,
  className,
}: ScorerPickerProps) {
  const t = useTranslations("eval")
  const checked = new Set(value)

  const toggle = (id: string) => {
    const next = new Set(checked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }

  const setGroup = (entries: ScorerCatalogEntry[], on: boolean) => {
    const next = new Set(checked)
    for (const e of entries) {
      if (on) next.add(e.id)
      else next.delete(e.id)
    }
    onChange([...next])
  }

  const dimensionLabel = (d: EvalDimension) => t(`dimensions.${d}`)

  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="scorer-picker">
      {SCORER_DIMENSIONS.map((dimension) => {
        const entries = scorersForDimension(dimension)
        const groupChecked = entries.filter((e) => checked.has(e.id)).length
        const allOn = groupChecked === entries.length
        return (
          <div key={dimension} className="rounded-md border p-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{dimensionLabel(dimension)}</span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {t("scorerPicker.groupCount", { on: groupChecked, total: entries.length })}
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => setGroup(entries, !allOn)}
              >
                {allOn ? t("scorerPicker.none") : t("scorerPicker.all")}
              </Button>
            </div>
            <div className="mt-2 flex flex-col gap-1">
              {entries.map((e) => {
                const disabled = e.requiresLlm && !judgeAvailable
                return (
                  <label
                    key={e.id}
                    className={cn(
                      "flex items-center gap-2 rounded px-1 py-0.5 text-xs",
                      disabled ? "opacity-50" : "hover:bg-accent cursor-pointer"
                    )}
                  >
                    <input
                      type="checkbox"
                      aria-label={t(`scorerCatalog.${e.id}` as never)}
                      // Disabled scorers are never shown checked: "selected
                      // but cannot run" is not a state the user can act on.
                      checked={!disabled && checked.has(e.id)}
                      disabled={disabled}
                      onChange={() => toggle(e.id)}
                    />
                    <span className="flex-1 truncate">{t(`scorerCatalog.${e.id}` as never)}</span>
                    {e.requiresLlm && (
                      <Badge
                        variant="outline"
                        className="h-4 shrink-0 px-1 text-[9px] uppercase"
                        title={
                          judgeAvailable
                            ? t("scorerPicker.llmHint")
                            : t("scorerPicker.llmUnavailable")
                        }
                      >
                        {t("scorerPicker.llmBadge")}
                      </Badge>
                    )}
                  </label>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
