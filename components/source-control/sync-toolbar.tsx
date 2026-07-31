"use client"

/**
 * Network + overflow actions: fetch / pull / push / sync icon buttons (with
 * per-op spinners) plus an overflow menu for pull-rebase, fetch-prune, force
 * push, stash, timeline, refresh, and discard-all.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  CloudIcon,
  GitCompareIcon,
  GitBranchPlusIcon,
  GitMergeIcon,
  HistoryIcon,
  Undo2Icon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  ScissorsIcon,
  TagIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadCloudIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useGitBranchInfo, useGitStore } from "@/stores/git/git-store"
import { useSourceControlPrefs } from "@/hooks/git/use-source-control-prefs"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { DiscardConfirmDialog } from "./discard-confirm-dialog"

interface SyncToolbarProps {
  actions: Pick<
    UseGitActionsResult,
    "fetch" | "pull" | "push" | "sync" | "discardAll" | "mergeAbort" | "reset"
  >
  onOpenStash: () => void
  onOpenTimeline: () => void
  onOpenRemotes: () => void
  onOpenTags: () => void
  onOpenCompare: () => void
  onOpenWorktrees?: () => void
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

export function SyncToolbar({
  actions,
  onOpenStash,
  onOpenTimeline,
  onOpenRemotes,
  onOpenTags,
  onOpenCompare,
  onOpenWorktrees = () => {},
  onRefresh,
}: SyncToolbarProps) {
  const t = useTranslations("sourceControl")
  const ops = useGitStore((s) => s.ops)
  const isMerging = useGitStore((s) => s.status?.isMerging ?? false)
  const { branch, upstream } = useGitBranchInfo()
  const { prefs } = useSourceControlPrefs()
  // A checked-out branch with no upstream pushes nowhere — offer publish instead.
  const needsPublish = branch !== null && upstream === null
  // Force push needs an existing upstream to overwrite; disable it otherwise.
  const canForcePush = branch !== null && upstream !== null
  // Undoing a commit mid-merge/rebase would corrupt the sequencer state.
  const sequencerBusy = useGitStore((s) => s.repoState?.operationInProgress != null)

  const [confirmForcePush, setConfirmForcePush] = useState(false)
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false)

  const runForcePush = () => void actions.push({ forceWithLease: true })
  const requestForcePush = () => {
    if (prefs.confirmForcePush) setConfirmForcePush(true)
    else runForcePush()
  }
  const runDiscardAll = () => void actions.discardAll(false)
  const requestDiscardAll = () => {
    if (prefs.confirmDiscard) setConfirmDiscardAll(true)
    else runDiscardAll()
  }

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
        onClick={() => void actions.pull({ rebase: prefs.pullRebase })}
        testId="sync-pull"
      >
        <ArrowDownToLineIcon className="size-3.5" />
      </IconBtn>
      {needsPublish ? (
        <IconBtn
          label={t("actions.publish")}
          busy={ops.push}
          onClick={() => void actions.push({ setUpstream: true })}
          testId="sync-publish"
        >
          <UploadCloudIcon className="size-3.5" />
        </IconBtn>
      ) : (
        <IconBtn
          label={t("actions.push")}
          busy={ops.push}
          onClick={() => void actions.push()}
          testId="sync-push"
        >
          <ArrowUpFromLineIcon className="size-3.5" />
        </IconBtn>
      )}
      <IconBtn
        label={t("actions.fetch")}
        busy={ops.fetch}
        onClick={() => void actions.fetch({ prune: prefs.fetchPrune })}
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
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={onRefresh} data-testid="more-refresh">
            <RefreshCwIcon className="size-3.5" />
            {t("actions.refresh")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => void actions.pull({ rebase: true })}
            data-testid="more-pull-rebase"
          >
            <ArrowDownToLineIcon className="size-3.5" />
            {t("actions.pullRebase")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void actions.fetch({ prune: true })}
            data-testid="more-fetch-prune"
          >
            <ScissorsIcon className="size-3.5" />
            {t("actions.fetchPrune")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            disabled={!canForcePush}
            onSelect={(e) => {
              // preventDefault: opening the confirm dialog from a closing menu
              // races Radix focus restore (sticky body[pointer-events:none]).
              e.preventDefault()
              requestForcePush()
            }}
            data-testid="more-force-push"
          >
            <TriangleAlertIcon className="size-3.5" />
            {t("actions.forcePush")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* preventDefault on overlay-opening items: opening a Sheet from a
              closing menu races Radix focus restore (sticky pointer-events). */}
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault()
              onOpenStash()
            }}
            data-testid="more-stash"
          >
            <ArchiveIcon className="size-3.5" />
            {t("stash.title")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault()
              onOpenTimeline()
            }}
            data-testid="more-timeline"
          >
            <HistoryIcon className="size-3.5" />
            {t("timeline.title")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault()
              onOpenRemotes()
            }}
            data-testid="more-remotes"
          >
            <CloudIcon className="size-3.5" />
            {t("remotes.title")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault()
              onOpenTags()
            }}
            data-testid="more-tags"
          >
            <TagIcon className="size-3.5" />
            {t("tags.title")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault()
              onOpenCompare()
            }}
            data-testid="more-compare"
          >
            <GitCompareIcon className="size-3.5" />
            {t("compare.menuItem")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault()
              onOpenWorktrees()
            }}
            data-testid="more-worktrees"
          >
            <GitBranchPlusIcon className="size-3.5" />
            {t("worktrees.title")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void actions.reset("soft", "HEAD~1")}
            disabled={sequencerBusy}
            data-testid="more-undo-commit"
          >
            <Undo2Icon className="size-3.5" />
            {t("actions.undoLastCommit")}
          </DropdownMenuItem>
          {isMerging && (
            <DropdownMenuItem
              onSelect={() => void actions.mergeAbort()}
              data-testid="more-abort-merge"
            >
              <GitMergeIcon className="size-3.5" />
              {t("actions.abortMerge")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive"
            onSelect={(e) => {
              e.preventDefault()
              requestDiscardAll()
            }}
            data-testid="more-discard-all"
          >
            <Trash2Icon className="size-3.5" />
            {t("actions.discardAll")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmForcePush} onOpenChange={setConfirmForcePush}>
        <AlertDialogContent data-testid="force-push-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("forcePush.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("forcePush.confirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={runForcePush}
              data-testid="force-push-confirm-action"
            >
              {t("forcePush.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DiscardConfirmDialog
        open={confirmDiscardAll}
        onOpenChange={setConfirmDiscardAll}
        onConfirm={() => {
          runDiscardAll()
          setConfirmDiscardAll(false)
        }}
      />
    </div>
  )
}
