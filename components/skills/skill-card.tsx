"use client"

import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CopyIcon,
  DownloadIcon,
  FileCodeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PowerIcon,
  Trash2Icon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { Skill } from "@/lib/claude/types"
import { inferCategory, inferSource } from "@/lib/db/skills"
import { getCategoryMeta, getSourceMeta } from "@/lib/skills/categories"
import { isTauri } from "@/lib/tauri"

interface Props {
  skill: Skill
  selected: boolean
  onToggleSelect: (id: string) => void
  onOpen: (id: string) => void
  onEdit: (id: string) => void
  onOpenInEditor?: (id: string) => void
  onDuplicate: (skill: Skill) => void
  onExport: (skill: Skill) => void
  onDelete: (skill: Skill) => void
  onToggleStatus: (skill: Skill) => void
}

export function SkillCard({
  skill,
  selected,
  onToggleSelect,
  onOpen,
  onEdit,
  onOpenInEditor,
  onDuplicate,
  onExport,
  onDelete,
  onToggleStatus,
}: Props) {
  const t = useTranslations("skills")
  const category = getCategoryMeta(inferCategory(skill))
  const source = getSourceMeta(inferSource(skill))
  const status = skill.status ?? "enabled"
  const Icon = category.icon
  const isBuiltIn = skill.isBuiltIn === true

  return (
    <Card
      className={cn(
        "group relative flex flex-col gap-2 p-3 transition-colors hover:border-primary/40",
        selected && "border-primary",
        status === "disabled" && "opacity-60"
      )}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(skill.id)}
          className="mt-0.5"
          aria-label={`Select ${skill.name}`}
        />
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
            category.color
          )}
        >
          <Icon className="size-4" />
        </div>
        <button type="button" onClick={() => onOpen(skill.id)} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-medium">{skill.name}</p>
          {skill.description && (
            <p className="line-clamp-1 text-[11px] text-muted-foreground">{skill.description}</p>
          )}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 opacity-0 group-hover:opacity-100"
              aria-label={`Actions for ${skill.name}`}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 text-xs">
            <DropdownMenuItem
              onSelect={() => (onOpenInEditor ?? onEdit)(skill.id)}
              disabled={isBuiltIn}
            >
              <FileCodeIcon className="mr-2 size-3.5" />
              {t("card.openInEditor")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onEdit(skill.id)} disabled={isBuiltIn}>
              <PencilIcon className="mr-2 size-3.5" />
              {t("card.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDuplicate(skill)}>
              <CopyIcon className="mr-2 size-3.5" />
              {t("card.duplicate")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onExport(skill)}>
              <DownloadIcon className="mr-2 size-3.5" />
              {t("card.export")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onToggleStatus(skill)}>
              <PowerIcon className="mr-2 size-3.5" />
              {status === "enabled" ? t("card.disable") : t("card.enable")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => onDelete(skill)}
              disabled={isBuiltIn}
              className="text-destructive focus:text-destructive"
            >
              <Trash2Icon className="mr-2 size-3.5" />
              {t("card.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 pl-9">
        <Badge variant={source.badgeVariant} className="h-5 text-[10px]">
          {t(`source.${source.labelKey}` as never)}
        </Badge>
        <Badge variant="outline" className="h-5 text-[10px]">
          {t(`category.${category.labelKey}` as never)}
        </Badge>
        {skill.validationErrors && skill.validationErrors.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="destructive"
                className="h-5 gap-1 text-[10px]"
                aria-label={t("validation.cardBadge", { count: skill.validationErrors.length })}
              >
                <AlertTriangleIcon className="size-3" />
                {t("validation.cardBadge", { count: skill.validationErrors.length })}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <ul className="space-y-0.5 text-xs">
                {skill.validationErrors.slice(0, 3).map((e, i) => (
                  <li key={i}>• {e.message}</li>
                ))}
                {skill.validationErrors.length > 3 && (
                  <li>… +{skill.validationErrors.length - 3} more</li>
                )}
              </ul>
            </TooltipContent>
          </Tooltip>
        )}
        {isTauri() && <SyncDot skill={skill} />}
        {status === "disabled" && (
          <Badge variant="secondary" className="h-5 text-[10px]">
            {t("status.disabled")}
          </Badge>
        )}
        {(skill.tags ?? []).slice(0, 3).map((tag) => (
          <Badge key={tag} variant="outline" className="h-5 text-[10px]">
            {tag}
          </Badge>
        ))}
        {(skill.tags ?? []).length > 3 && (
          <span className="text-[10px] text-muted-foreground">
            +{(skill.tags ?? []).length - 3}
          </span>
        )}
      </div>

      {(skill.usageCount ?? 0) > 0 && (
        <p className="pl-9 text-[10px] text-muted-foreground">
          {t("detail.metaUsage", { count: skill.usageCount ?? 0 })}
        </p>
      )}
    </Card>
  )
}

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
