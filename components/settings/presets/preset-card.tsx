"use client"

import { useTranslations } from "next-intl"
import {
  CopyIcon,
  GripVerticalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  StarIcon,
  StarOffIcon,
  Trash2Icon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import type { SystemPromptPreset } from "@/lib/claude/types"
import { getCategorySpec } from "@/lib/presets/categories"

interface Props {
  preset: SystemPromptPreset
  /** When true, render the drag handle (used in reorder mode). */
  reorderable?: boolean
  /** Drag handle props from `useSortable`. Wired through when present. */
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement>
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onToggleDefault: () => void
  onToggleFavorite: () => void
}

function presetGlyph(preset: SystemPromptPreset): string {
  const trimmed = preset.icon?.trim()
  if (trimmed) return trimmed
  const initial = preset.name.trim().charAt(0).toUpperCase()
  return initial || "?"
}

function presetColor(preset: SystemPromptPreset): string {
  return preset.color ?? "oklch(0.7 0.14 250)"
}

export function PresetCard({
  preset,
  reorderable = false,
  dragHandleProps,
  onEdit,
  onDuplicate,
  onDelete,
  onToggleDefault,
  onToggleFavorite,
}: Props) {
  const t = useTranslations("presets")
  const tCard = useTranslations("presets.card")
  const tCategory = useTranslations("presets.category")
  const isBuiltIn = preset.isBuiltIn === true
  const categorySpec = getCategorySpec(preset.category)

  const safeT = (k: string, fallback: string) => {
    const out = t(k as never)
    return out === `presets.${k}` || out === k ? fallback : out
  }
  const safeTCard = (k: string, fallback: string) => {
    const out = tCard(k as never)
    return out === `presets.card.${k}` || out === k ? fallback : out
  }
  const safeTCategory = (k: string, fallback: string) => {
    const out = tCategory(k as never)
    return out === `presets.category.${k}` || out === k ? fallback : out
  }

  return (
    <Card className="p-3">
      <div className="flex items-start gap-3">
        {reorderable && (
          <button
            type="button"
            className="touch-none cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
            aria-label={safeTCard("dragHandle", "Drag to reorder")}
            {...dragHandleProps}
          >
            <GripVerticalIcon className="size-4" />
          </button>
        )}
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-base"
          style={{ backgroundColor: presetColor(preset), color: "white" }}
          aria-hidden
        >
          {presetGlyph(preset)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{preset.name}</p>
            {preset.isDefault && (
              <Badge variant="default" className="text-[10px]">
                {safeTCard("default", "Default")}
              </Badge>
            )}
            {isBuiltIn && (
              <Badge variant="secondary" className="text-[10px]">
                {safeTCard("builtIn", "Built-in")}
              </Badge>
            )}
            {preset.isFavorite && !isBuiltIn && (
              <StarIcon className="size-3 fill-amber-400 text-amber-400" aria-hidden />
            )}
            {categorySpec && (
              <Badge variant="outline" className={cn("text-[10px]", categorySpec.tone)}>
                {safeTCategory(categorySpec.labelKey, categorySpec.id)}
              </Badge>
            )}
            {preset.model && (
              <Badge variant="outline" className="font-mono text-[10px]">
                {preset.model}
              </Badge>
            )}
          </div>
          {preset.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{preset.description}</p>
          )}
          {!preset.description && preset.content && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{preset.content}</p>
          )}
          {(preset.usageCount ?? 0) > 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {safeTCard("usedNTimes", `Used ${preset.usageCount} times`).replace(
                "{count}",
                String(preset.usageCount)
              )}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onToggleFavorite}
            aria-label={
              preset.isFavorite
                ? safeTCard("unfavorite", `Unfavorite ${preset.name}`)
                : safeTCard("favorite", `Favorite ${preset.name}`)
            }
            title={
              preset.isFavorite
                ? safeT("actions.unfavorite", "Remove from favorites")
                : safeT("actions.favorite", "Add to favorites")
            }
            disabled={isBuiltIn}
          >
            {preset.isFavorite ? (
              <StarOffIcon className="size-3.5" />
            ) : (
              <StarIcon className="size-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onToggleDefault}
            aria-label={
              preset.isDefault
                ? safeTCard("clearDefault", `Clear default on ${preset.name}`)
                : safeTCard("setDefault", `Set ${preset.name} as default`)
            }
            title={
              preset.isDefault
                ? safeT("actions.clearDefault", "Clear default")
                : safeT("actions.setDefault", "Set as default")
            }
          >
            {preset.isDefault ? (
              <PinOffIcon className="size-3.5" />
            ) : (
              <PinIcon className="size-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onEdit}
            aria-label={`${safeT("actions.edit", "Edit")} ${preset.name}`}
            title={
              isBuiltIn
                ? safeT("readOnlyTooltip", "Built-in preset — duplicate to edit")
                : safeT("actions.edit", "Edit")
            }
            disabled={isBuiltIn}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onDuplicate}
            aria-label={`${safeT("actions.duplicate", "Duplicate")} ${preset.name}`}
            title={safeT("actions.duplicate", "Duplicate")}
          >
            <CopyIcon className="size-3.5" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-destructive hover:text-destructive"
                aria-label={`${safeT("actions.delete", "Delete")} ${preset.name}`}
                title={
                  isBuiltIn
                    ? safeT("readOnlyDeleteTooltip", "Built-in presets can't be deleted")
                    : safeT("actions.delete", "Delete")
                }
                disabled={isBuiltIn}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{safeT("deleteConfirmTitle", "Delete preset?")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {safeT(
                    "deleteConfirmDescription",
                    `"${preset.name}" will be removed from your library. Sessions currently using it keep their copy of the system prompt.`
                  ).replace("{name}", preset.name)}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{safeT("actions.cancel", "Cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={onDelete}>
                  {safeT("actions.delete", "Delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </Card>
  )
}
