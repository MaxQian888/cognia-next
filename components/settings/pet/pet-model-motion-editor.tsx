// Motion-mapping tab of the per-model Live2D config dialog. One row per
// mappable key (11 resting states + 6 namespaced one-shots): pick a motion
// group (default convention / explicit engine default / a real group), an
// index within the group (random or fixed), and an expression. Unset rows are
// OMITTED from the override table so the naming-convention resolver keeps
// governing them; "engine default" persists an empty entry.

"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { PlayIcon } from "lucide-react"
import { ALL_MAPPING_ROWS, type MappingRow } from "@/lib/pet/live2d/state-keys"
import type { Live2dMotionOverride, Live2dMotionOverrides } from "@/types/pet"

/** Sentinel select values that are not real group/expression names. */
const SENTINEL_DEFAULT = "__default"
const SENTINEL_ENGINE = "__engine"
const SENTINEL_RANDOM = "__random"
const SENTINEL_NO_EXPRESSION = "__none"

export interface PetModelMotionEditorProps {
  /** The model's real capabilities (drives the select options). */
  motionGroups: string[]
  expressionIds: string[]
  /** Motion count per group when known — sizes the index dropdown. */
  motionGroupCounts: Record<string, number>
  value: Live2dMotionOverrides
  onChange: (next: Live2dMotionOverrides) => void
  /** Plays the row's key in the dialog preview. */
  onTest: (row: MappingRow) => void
}

function groupSelectValue(entry: Live2dMotionOverride | undefined): string {
  if (entry === undefined) return SENTINEL_DEFAULT
  return entry.motionGroup ?? SENTINEL_ENGINE
}

export function PetModelMotionEditor({
  motionGroups,
  expressionIds,
  motionGroupCounts,
  value,
  onChange,
  onTest,
}: PetModelMotionEditorProps) {
  const t = useTranslations("settings.pet.live2d.config")
  const tStates = useTranslations("settings.pet.live2d.stateLabels")
  const tShots = useTranslations("settings.pet.live2d.oneShotLabels")

  const setEntry = (key: string, entry: Live2dMotionOverride | undefined) => {
    const next = { ...value }
    if (entry === undefined) delete next[key]
    else next[key] = entry
    onChange(next)
  }

  const handleGroupChange = (row: MappingRow, selected: string) => {
    if (selected === SENTINEL_DEFAULT) {
      setEntry(row.key, undefined)
      return
    }
    const prev = value[row.key]
    if (selected === SENTINEL_ENGINE) {
      // Engine default: drop the motion fields, keep a chosen expression.
      setEntry(row.key, prev?.expressionId !== undefined ? { expressionId: prev.expressionId } : {})
      return
    }
    // Switching groups resets the index to random (counts differ per group).
    setEntry(row.key, {
      ...(prev?.expressionId !== undefined ? { expressionId: prev.expressionId } : {}),
      motionGroup: selected,
    })
  }

  const handleIndexChange = (row: MappingRow, selected: string) => {
    const prev = value[row.key]
    if (prev?.motionGroup === undefined) return
    const next: Live2dMotionOverride = { ...prev }
    if (selected === SENTINEL_RANDOM) delete next.motionIndex
    else next.motionIndex = Number(selected)
    setEntry(row.key, next)
  }

  const handleExpressionChange = (row: MappingRow, selected: string) => {
    const prev = value[row.key] ?? {}
    const next: Live2dMotionOverride = { ...prev }
    if (selected === SENTINEL_NO_EXPRESSION) delete next.expressionId
    else next.expressionId = selected
    setEntry(row.key, next)
  }

  const label = (row: MappingRow) => (row.kind === "state" ? tStates(row.id) : tShots(row.id))

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-2 text-xs text-muted-foreground">
        <span>{t("columnKey")}</span>
        <span>{t("motionGroup")}</span>
        <span>{t("motionIndex")}</span>
        <span>{t("expression")}</span>
        <span />
      </div>
      {ALL_MAPPING_ROWS.map((row) => {
        const entry = value[row.key]
        const group = entry?.motionGroup
        const count = group !== undefined ? (motionGroupCounts[group] ?? 0) : 0
        return (
          <div
            key={row.key}
            data-testid={`pet-mapping-row-${row.key}`}
            className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-2"
          >
            <span className="truncate text-sm" title={label(row)}>
              {label(row)}
              {row.kind === "oneShot" && (
                <span className="ml-1 rounded bg-secondary px-1 py-0.5 text-[10px]">
                  {t("oneShotTag")}
                </span>
              )}
            </span>

            <select
              aria-label={t("motionGroup")}
              data-testid={`pet-mapping-group-${row.key}`}
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={groupSelectValue(entry)}
              onChange={(e) => handleGroupChange(row, e.target.value)}
            >
              <option value={SENTINEL_DEFAULT}>{t("optionDefault")}</option>
              <option value={SENTINEL_ENGINE}>{t("optionEngine")}</option>
              {motionGroups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>

            <select
              aria-label={t("motionIndex")}
              data-testid={`pet-mapping-index-${row.key}`}
              className="rounded-md border bg-background px-2 py-1 text-sm"
              disabled={group === undefined}
              value={entry?.motionIndex === undefined ? SENTINEL_RANDOM : String(entry.motionIndex)}
              onChange={(e) => handleIndexChange(row, e.target.value)}
            >
              <option value={SENTINEL_RANDOM}>{t("indexRandom")}</option>
              {Array.from({ length: count }, (_, i) => (
                <option key={i} value={String(i)}>
                  {i}
                </option>
              ))}
            </select>

            <select
              aria-label={t("expression")}
              data-testid={`pet-mapping-expression-${row.key}`}
              className="rounded-md border bg-background px-2 py-1 text-sm"
              disabled={entry === undefined}
              value={entry?.expressionId ?? SENTINEL_NO_EXPRESSION}
              onChange={(e) => handleExpressionChange(row, e.target.value)}
            >
              <option value={SENTINEL_NO_EXPRESSION}>{t("optionNoExpression")}</option>
              {expressionIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>

            <Button
              variant="ghost"
              size="icon"
              aria-label={t("test")}
              data-testid={`pet-mapping-test-${row.key}`}
              onClick={() => onTest(row)}
            >
              <PlayIcon className="size-4" />
            </Button>
          </div>
        )
      })}
      <Button variant="outline" size="sm" onClick={() => onChange({})}>
        {t("resetMappings")}
      </Button>
    </div>
  )
}
