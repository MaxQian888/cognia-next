"use client"

/**
 * The item's masthead (ADR-0179 §1): what it is, and what you can do to it.
 *
 * Outside the scroller, so the item stays named however far down the
 * sections go. Actions are gated by the source's `capabilities`, but a
 * capability the source declares false renders a disabled control with a
 * reason rather than nothing: "never existed", "one fix away" and "broken"
 * had collapsed into the same missing button.
 */

import { useTranslations } from "next-intl"
import {
  ArrowUpRightIcon,
  CopyIcon,
  GitBranchIcon,
  HistoryIcon,
  MonitorUpIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { formatNextRun } from "@/lib/scheduler/format-utils"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

import { AuthoredByBadge, ItemStatusBadge, KindPlate, useTriggerText } from "../kind-visuals"

export interface ItemActions {
  onRunNow: (item: UnifiedScheduledItem) => void
  onPause: (item: UnifiedScheduledItem) => void
  onResume: (item: UnifiedScheduledItem) => void
  /** Present when this page can edit the item in place. */
  onEdit?: (item: UnifiedScheduledItem) => void
  onDelete: (item: UnifiedScheduledItem) => void
  /** App-only extras. Absent means the item is not an app task. */
  onDuplicate?: () => void
  onBackfill?: () => void
  onOpenDependencyGraph?: () => void
  onPromote?: () => void
  onUnpromote?: () => void
  /** Whether the task is currently promoted to the OS scheduler. */
  promoted?: boolean
  promotionAvailable?: boolean
  promotionUnavailableReason?: string
}

export interface ItemHeroProps {
  item: UnifiedScheduledItem
  actions: ItemActions
  /** Something is in flight for this item; Run now waits. */
  busy?: boolean
  className?: string
}

export function ItemHero({ item, actions, busy = false, className }: ItemHeroProps) {
  const t = useTranslations("scheduler")
  const tDetail = useTranslations("scheduler.detail")
  const triggerText = useTriggerText()
  const isPaused = item.status === "paused"
  const nextRun = item.nextRunAt ? new Date(item.nextRunAt) : undefined

  const runReason = item.capabilities.runNow ? undefined : tDetail("cannot.runNow")
  const pauseReason = item.capabilities.pause ? undefined : tDetail("cannot.pause")
  const deleteReason = item.capabilities.delete ? undefined : tDetail("cannot.delete")
  // Editable here, editable elsewhere, or not editable at all: three answers.
  const editHere = item.capabilities.edit && actions.onEdit
  const editElsewhere = item.capabilities.edit && !actions.onEdit
  const editReason = item.capabilities.edit ? undefined : tDetail("cannot.edit")

  const hasOverflow =
    actions.onDuplicate ||
    actions.onBackfill ||
    actions.onOpenDependencyGraph ||
    actions.onPromote ||
    actions.onUnpromote ||
    editElsewhere

  return (
    <div className={cn("shrink-0 border-b px-4 py-3.5", className)} data-testid="item-hero">
      <div className="flex items-start gap-3">
        <KindPlate kind={item.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-tight">
              {item.name}
            </h2>
            <ItemStatusBadge status={item.status} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{t(`kindFilter.${item.kind}`)}</span>
            <span aria-hidden className="size-0.5 rounded-full bg-muted-foreground/50" />
            <span className="truncate">{triggerText(item.triggerSummary)}</span>
            <span aria-hidden className="size-0.5 rounded-full bg-muted-foreground/50" />
            <span data-testid="item-hero-next-run">
              {nextRun
                ? tDetail("nextRunIn", {
                    when: formatNextRun(nextRun, {
                      noSchedule: t("noSchedule"),
                      overdue: t("overdue"),
                      lessThanMinute: t("lessThanMinute"),
                    }),
                  })
                : t("noSchedule")}
            </span>
            <AuthoredByBadge source={item.createdBySource} />
          </div>
          {item.description ? (
            <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{item.description}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="item-hero-actions">
        <Button
          type="button"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => actions.onRunNow(item)}
          disabled={busy || !item.capabilities.runNow}
          title={runReason}
          data-testid="item-action-run"
        >
          <PlayIcon className="size-3.5" aria-hidden="true" />
          {t("runNow")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => (isPaused ? actions.onResume(item) : actions.onPause(item))}
          disabled={!item.capabilities.pause}
          title={pauseReason}
          data-testid={isPaused ? "item-action-resume" : "item-action-pause"}
        >
          {isPaused ? (
            <PlayIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <PauseIcon className="size-3.5" aria-hidden="true" />
          )}
          {isPaused ? t("resume") : t("pause")}
        </Button>
        {editHere ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            onClick={() => actions.onEdit?.(item)}
            data-testid="item-action-edit"
          >
            <PencilIcon className="size-3.5" aria-hidden="true" />
            {t("edit")}
          </Button>
        ) : editElsewhere ? (
          <Button
            asChild
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            data-testid="item-action-edit-elsewhere"
          >
            <Link href={item.origin.deepLinkHref}>
              <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
              {t("openInSourceEditor")}
            </Link>
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            disabled
            title={editReason}
            data-testid="item-action-edit-disabled"
          >
            <PencilIcon className="size-3.5" aria-hidden="true" />
            {t("edit")}
          </Button>
        )}
        <span className="ml-auto flex items-center gap-2">
          {hasOverflow ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  aria-label={t("moreOptions")}
                  data-testid="item-action-more"
                >
                  <MoreHorizontalIcon className="size-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {actions.onBackfill ? (
                  <DropdownMenuItem onClick={actions.onBackfill} data-testid="item-action-backfill">
                    <HistoryIcon className="mr-2 size-3.5" />
                    {t("backfill.open")}
                  </DropdownMenuItem>
                ) : null}
                {actions.onDuplicate ? (
                  <DropdownMenuItem
                    onClick={actions.onDuplicate}
                    data-testid="item-action-duplicate"
                  >
                    <CopyIcon className="mr-2 size-3.5" />
                    {t("duplicate")}
                  </DropdownMenuItem>
                ) : null}
                {actions.onOpenDependencyGraph ? (
                  <DropdownMenuItem
                    onClick={actions.onOpenDependencyGraph}
                    data-testid="item-action-dependencies"
                  >
                    <GitBranchIcon className="mr-2 size-3.5" />
                    {t("dependencyGraph.openFullGraph")}
                  </DropdownMenuItem>
                ) : null}
                {actions.onPromote && !actions.promoted ? (
                  <DropdownMenuItem
                    onClick={actions.onPromote}
                    disabled={!actions.promotionAvailable}
                    title={actions.promotionUnavailableReason}
                    data-testid="item-action-promote"
                  >
                    <MonitorUpIcon className="mr-2 size-3.5" />
                    {t("promote.button")}
                  </DropdownMenuItem>
                ) : null}
                {actions.onUnpromote && actions.promoted ? (
                  <DropdownMenuItem
                    onClick={actions.onUnpromote}
                    data-testid="item-action-unpromote"
                  >
                    <MonitorUpIcon className="mr-2 size-3.5" />
                    {t("promote.remove")}
                  </DropdownMenuItem>
                ) : null}
                {editElsewhere ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link href={item.origin.deepLinkHref}>
                        <ArrowUpRightIcon className="mr-2 size-3.5" />
                        {t("openInSourceEditor")}
                      </Link>
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
            onClick={() => actions.onDelete(item)}
            disabled={!item.capabilities.delete}
            title={deleteReason}
            data-testid="item-action-delete"
          >
            <Trash2Icon className="size-3.5" aria-hidden="true" />
            {t("delete")}
          </Button>
        </span>
      </div>
    </div>
  )
}
