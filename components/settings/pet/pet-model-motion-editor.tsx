"use client"

import { useTranslations } from "next-intl"
import { PlayIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ALL_MAPPING_ROWS, type MappingRow } from "@/lib/pet/live2d/state-keys"
import type { Live2dMotionOverride, Live2dMotionOverrides } from "@/types/pet"

const SENTINEL_DEFAULT = "__default"
const SENTINEL_ENGINE = "__engine"
const SENTINEL_RANDOM = "__random"
const SENTINEL_NO_EXPRESSION = "__none"

export interface PetModelMotionEditorProps {
  motionGroups: string[]
  expressionIds: string[]
  motionGroupCounts: Record<string, number>
  value: Live2dMotionOverrides
  onChange: (next: Live2dMotionOverrides) => void
  onTest: (row: MappingRow) => void
}

function groupSelectValue(entry: Live2dMotionOverride | undefined): string {
  if (entry === undefined) return SENTINEL_DEFAULT
  return entry.motionGroup ?? SENTINEL_ENGINE
}

function MappingSelect({
  label,
  testId,
  value,
  disabled,
  options,
  onValueChange,
}: {
  label: string
  testId: string
  value: string
  disabled?: boolean
  options: { value: string; label: string }[]
  onValueChange: (value: string) => void
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onValueChange}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        data-testid={testId}
        className="w-full @xl/pet-motion-editor:w-36"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
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
    const previous = value[row.key]
    if (selected === SENTINEL_ENGINE) {
      setEntry(
        row.key,
        previous?.expressionId !== undefined ? { expressionId: previous.expressionId } : {}
      )
      return
    }
    setEntry(row.key, {
      ...(previous?.expressionId !== undefined ? { expressionId: previous.expressionId } : {}),
      motionGroup: selected,
    })
  }

  const handleIndexChange = (row: MappingRow, selected: string) => {
    const previous = value[row.key]
    if (previous?.motionGroup === undefined) return
    const next: Live2dMotionOverride = { ...previous }
    if (selected === SENTINEL_RANDOM) delete next.motionIndex
    else next.motionIndex = Number(selected)
    setEntry(row.key, next)
  }

  const handleExpressionChange = (row: MappingRow, selected: string) => {
    const next: Live2dMotionOverride = { ...(value[row.key] ?? {}) }
    if (selected === SENTINEL_NO_EXPRESSION) delete next.expressionId
    else next.expressionId = selected
    setEntry(row.key, next)
  }

  const label = (row: MappingRow) => (row.kind === "state" ? tStates(row.id) : tShots(row.id))

  return (
    <div className="@container/pet-motion-editor flex min-w-0 flex-col">
      <div className="hidden grid-cols-[minmax(7rem,1fr)_9rem_7rem_9rem_2rem] items-center gap-2 border-b pb-2 text-xs text-muted-foreground @xl/pet-motion-editor:grid">
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
            className="grid min-w-0 gap-2 border-b py-3 last:border-b-0 @xl/pet-motion-editor:grid-cols-[minmax(7rem,1fr)_9rem_7rem_9rem_2rem] @xl/pet-motion-editor:items-center"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm" title={label(row)}>
                {label(row)}
              </span>
              {row.kind === "oneShot" ? <Badge variant="secondary">{t("oneShotTag")}</Badge> : null}
            </div>

            <MappingSelect
              label={t("motionGroup")}
              testId={`pet-mapping-group-${row.key}`}
              value={groupSelectValue(entry)}
              onValueChange={(selected) => handleGroupChange(row, selected)}
              options={[
                { value: SENTINEL_DEFAULT, label: t("optionDefault") },
                { value: SENTINEL_ENGINE, label: t("optionEngine") },
                ...motionGroups.map((motionGroup) => ({ value: motionGroup, label: motionGroup })),
              ]}
            />
            <MappingSelect
              label={t("motionIndex")}
              testId={`pet-mapping-index-${row.key}`}
              value={entry?.motionIndex === undefined ? SENTINEL_RANDOM : String(entry.motionIndex)}
              disabled={group === undefined}
              onValueChange={(selected) => handleIndexChange(row, selected)}
              options={[
                { value: SENTINEL_RANDOM, label: t("indexRandom") },
                ...Array.from({ length: count }, (_, index) => ({
                  value: String(index),
                  label: String(index),
                })),
              ]}
            />
            <MappingSelect
              label={t("expression")}
              testId={`pet-mapping-expression-${row.key}`}
              value={entry?.expressionId ?? SENTINEL_NO_EXPRESSION}
              disabled={entry === undefined}
              onValueChange={(selected) => handleExpressionChange(row, selected)}
              options={[
                { value: SENTINEL_NO_EXPRESSION, label: t("optionNoExpression") },
                ...expressionIds.map((expressionId) => ({
                  value: expressionId,
                  label: expressionId,
                })),
              ]}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${t("test")}: ${label(row)}`}
              data-testid={`pet-mapping-test-${row.key}`}
              onClick={() => onTest(row)}
            >
              <PlayIcon className="size-4" />
            </Button>
          </div>
        )
      })}
      <Button className="mt-3 w-fit" variant="outline" size="sm" onClick={() => onChange({})}>
        {t("resetMappings")}
      </Button>
    </div>
  )
}
