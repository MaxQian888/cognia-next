"use client"

import { memo } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import type { Skill } from "@/lib/claude/types"
import { inferCategory } from "@/lib/db/skills"
import { getCategoryMeta } from "@/lib/skills/categories"
import { isTauri } from "@/lib/tauri"

interface Props {
  skill: Skill
  /** Batch-selection checkbox state. */
  selected: boolean
  /** Whether this row is the one shown in the detail pane. */
  active: boolean
  onToggleSelect: (id: string) => void
  onOpen: (id: string) => void
}

/**
 * Compact row for the master-detail skill list (left pane). Mirrors the
 * provider sidebar item markup; the checkbox is a sibling of the row button
 * (never nested) so batch selection doesn't trigger `onOpen`.
 */
export const SkillListItem = memo(function SkillListItem({
  skill,
  selected,
  active,
  onToggleSelect,
  onOpen,
}: Props) {
  const t = useTranslations("skills")
  const category = getCategoryMeta(inferCategory(skill))
  const status = skill.status ?? "enabled"
  const Icon = category.icon
  const errorCount = skill.validationErrors?.length ?? 0

  return (
    <div className="flex items-center gap-2 pl-2">
      <Checkbox
        checked={selected}
        onCheckedChange={() => onToggleSelect(skill.id)}
        aria-label={t("card.selectAria", { name: skill.name })}
      />
      <button
        type="button"
        onClick={() => onOpen(skill.id)}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border-l-2 border-l-transparent px-2.5 py-2 text-left transition-colors",
          active ? "border-l-primary bg-accent font-medium" : "hover:bg-muted/50",
          status === "disabled" && "opacity-60"
        )}
      >
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
            category.color
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{skill.name}</span>
          {skill.description && (
            <span className="block truncate text-[11px] font-normal text-muted-foreground">
              {skill.description}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
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
        </span>
      </button>
    </div>
  )
})

function SyncDot({ skill }: { skill: Skill }) {
  const color = skill.lastSyncError
    ? "bg-destructive"
    : skill.syncFingerprint
      ? "bg-emerald-500"
      : "bg-muted"
  return (
    <span data-testid="skill-sync-dot" className={cn("size-2 rounded-full", color)} aria-hidden />
  )
}
