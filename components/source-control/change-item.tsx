"use client"

/**
 * A single changed-file row: status letter + path, hover-reveal inline actions,
 * and a right-click context menu. Click selects the file (opens its diff).
 */

import { useTranslations } from "next-intl"
import { CheckIcon, MinusIcon, Undo2Icon } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { GitFileChange } from "@/types/git"
import { splitPath, statusDecoration } from "./status-decoration"

export interface ChangeItemProps {
  change: GitFileChange
  selected: boolean
  onSelect: () => void
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
  onCopyPath?: () => void
  onViewHistory?: () => void
  onViewBlame?: () => void
  onRestore?: () => void
}

export function ChangeItem({
  change,
  selected,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  onCopyPath,
  onViewHistory,
  onViewBlame,
  onRestore,
}: ChangeItemProps) {
  const t = useTranslations("sourceControl")
  const deco = statusDecoration(change.status)
  const { dir, name } = splitPath(change.path)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={onSelect}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              onSelect()
            }
          }}
          data-testid={`change-item-${change.path}`}
          className={cn(
            "group flex h-7 cursor-pointer items-center gap-1.5 rounded px-2 text-xs",
            "hover:bg-accent",
            selected && "bg-accent"
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            <span className="text-foreground">{name}</span>
            {dir && <span className="ml-1.5 text-[10px] text-muted-foreground">{dir}</span>}
          </span>

          <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
            {onStage && (
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                aria-label={t("actions.stage")}
                title={t("actions.stage")}
                onClick={(e) => {
                  e.stopPropagation()
                  onStage()
                }}
                data-testid={`stage-${change.path}`}
              >
                <CheckIcon className="size-3" />
              </Button>
            )}
            {onUnstage && (
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                aria-label={t("actions.unstage")}
                title={t("actions.unstage")}
                onClick={(e) => {
                  e.stopPropagation()
                  onUnstage()
                }}
                data-testid={`unstage-${change.path}`}
              >
                <MinusIcon className="size-3" />
              </Button>
            )}
            {onDiscard && (
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                aria-label={t("actions.discard")}
                title={t("actions.discard")}
                onClick={(e) => {
                  e.stopPropagation()
                  onDiscard()
                }}
                data-testid={`discard-${change.path}`}
              >
                <Undo2Icon className="size-3" />
              </Button>
            )}
          </span>

          <span
            className={cn("w-4 shrink-0 text-center font-mono font-semibold", deco.colorClass)}
            title={t(`status.${deco.labelKey}`)}
            aria-label={t(`status.${deco.labelKey}`)}
          >
            {deco.letter}
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onSelect}>{t("actions.openChanges")}</ContextMenuItem>
        {onStage && <ContextMenuItem onSelect={onStage}>{t("actions.stage")}</ContextMenuItem>}
        {onUnstage && (
          <ContextMenuItem onSelect={onUnstage}>{t("actions.unstage")}</ContextMenuItem>
        )}
        {onDiscard && (
          <ContextMenuItem onSelect={onDiscard} className="text-destructive">
            {t("actions.discard")}
          </ContextMenuItem>
        )}
        {onRestore && (
          <ContextMenuItem
            onSelect={onRestore}
            className="text-destructive"
            data-testid={`restore-${change.path}`}
          >
            {t("actions.restore")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {onCopyPath && (
          <ContextMenuItem onSelect={onCopyPath}>{t("actions.copyPath")}</ContextMenuItem>
        )}
        {onViewHistory && (
          <ContextMenuItem onSelect={onViewHistory}>{t("actions.viewHistory")}</ContextMenuItem>
        )}
        {onViewBlame && (
          <ContextMenuItem onSelect={onViewBlame} data-testid={`blame-${change.path}`}>
            {t("actions.viewBlame")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
