"use client"

/**
 * The engaged filters, spelled out and individually removable.
 *
 * Before this row the only evidence that the board was showing a subset was a
 * number on a closed dropdown — which is exactly how "where did my issue go?"
 * happens. Every facet gets a chip, and every chip can be taken off without
 * opening a menu or clearing the rest.
 *
 * Which chips exist is decided in `lib/issues/filter-chips.ts`; this component
 * only localizes them, because a label's name, a project's name and an actor's
 * cached display name are not things a pure reducer should know about.
 */

import { SearchIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { IssueFilterChip } from "@/lib/issues/filter-chips"
import { defaultLabelColor, type LabelRow } from "@/types/labels"
import type { IssuePriority } from "@/types/issues"
import type { IssueSourceKind } from "@/types/issues/unified"

export interface ActiveFilterChipsProps {
  chips: readonly IssueFilterChip[]
  labelsById?: ReadonlyMap<string, LabelRow>
  projectNamesById?: ReadonlyMap<string, string>
  /** `actorKey` → display name, built from the items actually on the board. */
  assigneeLabels?: ReadonlyMap<string, string>
  onRemove: (chip: IssueFilterChip) => void
  onClearAll: () => void
}

export function ActiveFilterChips({
  chips,
  labelsById,
  projectNamesById,
  assigneeLabels,
  onRemove,
  onClearAll,
}: ActiveFilterChipsProps) {
  const t = useTranslations("issues")

  if (chips.length === 0) return null

  function describe(chip: IssueFilterChip): { facet: string; value: string } {
    switch (chip.facet) {
      case "query":
        return { facet: t("toolbar.facet.query"), value: chip.value }
      case "priorities":
        return {
          facet: t("toolbar.facet.priority"),
          value: t(`priority.${chip.value as IssuePriority}`),
        }
      case "labelIds":
        return {
          facet: t("toolbar.facet.labels"),
          value: labelsById?.get(chip.value)?.name ?? chip.value,
        }
      case "assignees":
        return {
          facet: t("toolbar.facet.assignee"),
          value: assigneeLabels?.get(chip.value) ?? chip.value,
        }
      case "sources":
        return {
          facet: t("toolbar.facet.source"),
          value: t(`source.${chip.value as IssueSourceKind}`),
        }
      case "issueProjectIds":
        return {
          facet: t("toolbar.facet.project"),
          value: projectNamesById?.get(chip.value) ?? chip.value,
        }
    }
  }

  return (
    // Wrapping rather than a single scrolling row: chips are the only evidence
    // a filter is on, so none of them may end up off-screen.
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="issue-filter-chips">
      {chips.map((chip) => {
        const { facet, value } = describe(chip)
        const swatch = chip.facet === "labelIds" ? (labelsById?.get(chip.value) ?? null) : null
        return (
          <Badge
            key={chip.key}
            variant="secondary"
            className="min-w-0 max-w-[16rem] shrink gap-1.5 py-0.5 pl-2 pr-1 font-normal"
            data-testid={`issue-filter-chip-${chip.key}`}
          >
            {chip.facet === "query" ? (
              <SearchIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            ) : null}
            {swatch ? (
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: swatch.color ?? defaultLabelColor(swatch.name) }}
              />
            ) : null}
            <span className="shrink-0 text-muted-foreground">{facet}</span>
            <span className="min-w-0 truncate">{value}</span>
            <button
              type="button"
              onClick={() => onRemove(chip)}
              aria-label={t("toolbar.removeFilter", { facet, value })}
              data-testid={`issue-filter-chip-remove-${chip.key}`}
              className="focus-visible:ring-ring/50 shrink-0 rounded-sm opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-[3px]"
            >
              <XIcon className="size-3" />
            </button>
          </Badge>
        )
      })}

      {chips.length > 1 ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={onClearAll}
          data-testid="issue-filter-clear-all"
        >
          {t("toolbar.clearFilters")}
        </Button>
      ) : null}
    </div>
  )
}
