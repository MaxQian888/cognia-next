"use client"

/**
 * Network + overflow actions: fetch / pull / push / sync icon buttons (with
 * per-op spinners) plus an overflow menu for stash, timeline, refresh, and
 * discard-all.
 */

import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useGitStore } from "@/stores/git/git-store"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"

interface SyncToolbarProps {
  actions: Pick<UseGitActionsResult, "fetch" | "pull" | "push" | "sync" | "discardAll">
  onOpenStash: () => void
  onOpenTimeline: () => void
  onRefresh: () => void
}

interface IconBtnProps {
  label: string
  busy: boolean
  onClick: () => void
  children: React.ReactNode
  testId: string
}

function IconBtn({ label, busy, onClick, children, testId }: IconBtnProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={label}
          onClick={onClick}
          disabled={busy}
          data-testid={testId}
        >
          {busy ? <Spinner className="size-3.5" /> : children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function SyncToolbar({ actions, onOpenStash, onOpenTimeline, onRefresh }: SyncToolbarProps) {
  const t = useTranslations("sourceControl")
  const ops = useGitStore((s) => s.ops)

  return (
    <div className="flex items-center gap-0.5" data-testid="sync-toolbar">
      <IconBtn
        label={t("actions.sync")}
        busy={ops.sync}
        onClick={() => void actions.sync()}
        testId="sync-sync"
      >
        <RefreshCwIcon className="size-3.5" />
      </IconBtn>
      <IconBtn
        label={t("actions.pull")}
        busy={ops.pull}
        onClick={() => void actions.pull()}
        testId="sync-pull"
      >
        <ArrowDownToLineIcon className="size-3.5" />
      </IconBtn>
      <IconBtn
        label={t("actions.push")}
        busy={ops.push}
        onClick={() => void actions.push()}
        testId="sync-push"
      >
        <ArrowUpFromLineIcon className="size-3.5" />
      </IconBtn>
      <IconBtn
        label={t("actions.fetch")}
        busy={ops.fetch}
        onClick={() => void actions.fetch()}
        testId="sync-fetch"
      >
        <ArrowDownToLineIcon className="size-3.5 rotate-180" />
      </IconBtn>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("actions.more")}
            data-testid="sync-more"
          >
            <MoreHorizontalIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={onRefresh} data-testid="more-refresh">
            <RefreshCwIcon className="size-3.5" />
            {t("actions.refresh")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenStash} data-testid="more-stash">
            <ArchiveIcon className="size-3.5" />
            {t("stash.title")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenTimeline} data-testid="more-timeline">
            <HistoryIcon className="size-3.5" />
            {t("timeline.title")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive"
            onSelect={() => void actions.discardAll(false)}
            data-testid="more-discard-all"
          >
            <Trash2Icon className="size-3.5" />
            {t("actions.discardAll")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
