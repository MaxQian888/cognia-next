"use client"

import { memo } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, ArrowUpCircleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import type { Skill } from "@cognia/agent-config-types"
import { inferCategory, inferSource } from "@/lib/db/skills"
import { getCategoryMeta, getSourceMeta } from "@/lib/skills/categories"
import { isTauri } from "@/lib/tauri"
import { useSkillsStore } from "@/stores/skills/skills-store"

/** Per-row display options, resolved from the skill panel preferences. */
export interface SkillListDisplay {
  density: "comfortable" | "compact"
  viewMode: "list" | "grid"
  showDescription: boolean
  showTags: boolean
  showSource: boolean
  showUsage: boolean
}

/**
 * Default display — preserves the pre-preferences look (comfortable list rows
 * with a description line). Used when a caller renders the item without an
 * explicit `display` prop.
 */
export const DEFAULT_LIST_DISPLAY: SkillListDisplay = {
  density: "comfortable",
  viewMode: "list",
  showDescription: true,
  showTags: false,
  showSource: false,
  showUsage: false,
}

const MAX_TAG_CHIPS = 3

interface Props {
  skill: Skill
  /** Batch-selection checkbox state. */
  selected: boolean
  /** Whether this row is the one shown in the detail pane. */
  active: boolean
  onToggleSelect: (id: string) => void
  onOpen: (id: string) => void
  /** Display options (density, view mode, per-field visibility). */
  display?: SkillListDisplay
}

/**
 * Row (or card) for the master-detail skill list. Adapts to the user's display
 * preferences: comfortable/compact density, list/grid layout, and per-field
 * visibility (description, tags, source badge, usage count). The checkbox is a
 * sibling of the row button (never nested) so batch selection doesn't trigger
 * `onOpen`.
 */
export const SkillListItem = memo(function SkillListItem({
  skill,
  selected,
  active,
  onToggleSelect,
  onOpen,
  display = DEFAULT_LIST_DISPLAY,
}: Props) {
  const t = useTranslations("skills")
  const category = getCategoryMeta(inferCategory(skill))
  const status = skill.status ?? "enabled"
  const Icon = category.icon
  const errorCount = skill.validationErrors?.length ?? 0
  const updateAvailable = useSkillsStore((s) => Boolean(s.updateAvailable[skill.id]))
  const compact = display.density === "compact"
  const grid = display.viewMode === "grid"

  const tags = display.showTags ? (skill.tags ?? []).slice(0, MAX_TAG_CHIPS) : []
  const sourceMeta = display.showSource ? getSourceMeta(inferSource(skill)) : null
  const usageCount = skill.usageCount ?? 0

  const selectCheckbox = (
    <Checkbox
      checked={selected}
      onCheckedChange={() => onToggleSelect(skill.id)}
      aria-label={t("card.selectAria", { name: skill.name })}
    />
  )

  const iconBox = (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md",
        compact ? "h-6 w-6" : "h-7 w-7",
        category.color
      )}
    >
      <Icon className="size-3.5" />
    </span>
  )

  const metaChips =
    sourceMeta || tags.length > 0 || display.showUsage ? (
      <span className="mt-0.5 flex flex-wrap items-center gap-1">
        {sourceMeta && (
          <Badge
            variant={sourceMeta.badgeVariant}
            className="h-4 px-1.5 text-[9px]"
            data-testid="skill-source-badge"
          >
            {t(`source.${sourceMeta.labelKey}` as never)}
          </Badge>
        )}
        {tags.map((tag) => (
          <Badge key={tag} variant="outline" className="h-4 px-1.5 text-[9px]">
            {tag}
          </Badge>
        ))}
        {display.showUsage && (
          <span className="text-[9px] text-muted-foreground" data-testid="skill-usage-count">
            {t("card.usageCount", { count: usageCount })}
          </span>
        )}
      </span>
    ) : null

  const statusBadges = (
    <>
      {updateAvailable && (
        <Badge
          variant="secondary"
          className="h-5 gap-1 text-[10px]"
          data-testid="skill-update-badge"
        >
          <ArrowUpCircleIcon className="size-3" />
          {t("detail.updateAvailable")}
        </Badge>
      )}
      {errorCount > 0 && (
        <Badge
          variant="destructive"
          className="h-5 gap-1 text-[10px]"
          aria-label={t("validation.cardBadge", { count: errorCount })}
        >
          <AlertTriangleIcon className="size-3" />
          {errorCount}
        </Badge>
      )}
      {status === "disabled" && (
        <Badge variant="secondary" className="h-5 text-[10px]">
          {t("status.disabled")}
        </Badge>
      )}
      {isTauri() && <SyncDot skill={skill} />}
    </>
  )

  if (grid) {
    return (
      <div className="relative min-w-0 border-b border-r">
        <span className="absolute right-2 top-2 z-10">{selectCheckbox}</span>
        <Button
          type="button"
          variant="ghost"
          onClick={() => onOpen(skill.id)}
          aria-current={active ? "true" : undefined}
          className={cn(
            "h-full w-full items-stretch justify-start whitespace-normal rounded-none border-l-2 border-l-transparent text-left",
            compact ? "p-2" : "p-3",
            active ? "border-l-primary bg-accent font-medium" : "hover:bg-muted/50",
            status === "disabled" && "opacity-60"
          )}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="flex items-center gap-2 pr-6">
              {iconBox}
              <span className="min-w-0 flex-1 truncate text-sm">{skill.name}</span>
            </span>
            {display.showDescription && skill.description && (
              <span className="line-clamp-2 text-[11px] font-normal text-muted-foreground">
                {skill.description}
              </span>
            )}
            <span className="flex flex-wrap items-center gap-1">
              {metaChips}
              {statusBadges}
            </span>
          </span>
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 pl-2">
      {selectCheckbox}
      <Button
        type="button"
        variant="ghost"
        onClick={() => onOpen(skill.id)}
        aria-current={active ? "true" : undefined}
        className={cn(
          "h-auto min-w-0 flex-1 justify-start gap-2.5 whitespace-normal rounded-none border-l-2 border-l-transparent px-2.5 text-left",
          compact ? "py-1.5" : "py-2",
          active ? "border-l-primary bg-accent font-medium" : "hover:bg-muted/50",
          status === "disabled" && "opacity-60"
        )}
      >
        {iconBox}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{skill.name}</span>
          {display.showDescription && skill.description && (
            <span className="block truncate text-[11px] font-normal text-muted-foreground">
              {skill.description}
            </span>
          )}
          {metaChips}
        </span>
        <span className="flex shrink-0 items-center gap-1">{statusBadges}</span>
      </Button>
    </div>
  )
})

function SyncDot({ skill }: { skill: Skill }) {
  const t = useTranslations("skills.card")
  const label = skill.lastSyncError
    ? t("syncError")
    : skill.syncFingerprint
      ? t("syncCurrent")
      : t("syncPending")
  const color = skill.lastSyncError
    ? "bg-destructive"
    : skill.syncFingerprint
      ? "bg-success"
      : "bg-muted"
  return <span role="img" aria-label={label} className={cn("size-2 rounded-full", color)} />
}
