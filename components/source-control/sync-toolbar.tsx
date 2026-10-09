"use client"

/**
 * The header's network + tools controls, as two buttons a newcomer can read.
 *
 *  - One labelled split button for the network. Its primary half does what
 *    the branch's tracking state asks for (`resolveSyncIntent`): Publish, Pull
 *    ↓n, Push ↑n, Sync ↓n ↑n, or Fetch, with a tooltip that says it in a
 *    sentence. Its chevron offers every network action by name, including the
 *    rebase / prune / force variants.
 *  - One "More" menu for everything else, grouped and labelled: repository
 *    views (stash, history, remotes, tags, compare, worktrees, stacks), commit
 *    repairs (undo, abort merge), refresh, and Discard All behind a separator.
 *
 * This replaced four unlabelled 28px icons (two of them arrows that differed
 * only in direction, Fetch drawn as a rotated Pull) that only a git user could
 * tell apart.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  CloudDownloadIcon,
  CloudIcon,
  GitCompareIcon,
  GitBranchPlusIcon,
  GitMergeIcon,
  HistoryIcon,
  LayersIcon,
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
import { ButtonGroup } from "@/components/ui/button-group"
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useGitBranchInfo, useGitStore } from "@/stores/git/git-store"
import { useSourceControlPrefs } from "@/hooks/git/use-source-control-prefs"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { resolveSyncIntent, type SyncIntent } from "@/lib/git/sync-intent"
import { DiscardConfirmDialog } from "./discard-confirm-dialog"

interface SyncToolbarProps {
  actions: Pick<
    UseGitActionsResult,
    "fetch" | "pull" | "push" | "sync" | "discardAll" | "mergeAbort" | "reset"
  > &
    Partial<Pick<UseGitActionsResult, "can">>
  onOpenStash: () => void
  onOpenTimeline: () => void
  onOpenRemotes: () => void
  onOpenTags: () => void
  onOpenCompare: () => void
  onOpenWorktrees?: () => void
  onOpenStacks?: () => void
  onRefresh: () => void
  /**
   * Drop the sync button's word and keep its icon and counts.
   *
   * Set when the PANE is narrow (`SOURCE_CONTROL_DENSE_WIDTH`): the header's
   * actions slot is `shrink-0`, so a label it cannot afford is taken out of
   * the title and the branch chip. The counts stay, because "is there anything
   * to pull" is the question the header exists to answer, and the tooltip and
   * `aria-label` still carry the full sentence.
   */
  dense?: boolean
}

const INTENT_ICON: Record<SyncIntent, typeof RefreshCwIcon> = {
  publish: UploadCloudIcon,
  sync: RefreshCwIcon,
  pull: ArrowDownToLineIcon,
  push: ArrowUpFromLineIcon,
  fetch: CloudDownloadIcon,
}

export function SyncToolbar({
  actions,
  onOpenStash,
  onOpenTimeline,
  onOpenRemotes,
  onOpenTags,
  onOpenCompare,
  onOpenWorktrees = () => {},
  onOpenStacks = () => {},
  onRefresh,
  dense = false,
}: SyncToolbarProps) {
  const t = useTranslations("sourceControl")
  const ops = useGitStore((s) => s.ops)
  const isMerging = useGitStore((s) => s.status?.isMerging ?? false)
  const { branch, upstream, ahead, behind } = useGitBranchInfo()
  const { prefs } = useSourceControlPrefs()
  // A checked-out branch with no upstream pushes nowhere — offer publish instead.
  const needsPublish = branch !== null && upstream === null
  // Force push needs an existing upstream to overwrite; disable it otherwise.
  const canForcePush = branch !== null && upstream !== null
  // Undoing a commit mid-merge/rebase would corrupt the sequencer state.
  const sequencerBusy = useGitStore((s) => s.repoState?.operationInProgress != null)
  const can = actions.can ?? (() => true)

  const [confirmForcePush, setConfirmForcePush] = useState(false)
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false)

  const intent = resolveSyncIntent({ branch, upstream, ahead, behind })
  const networkBusy = ops.fetch || ops.pull || ops.push || ops.sync
  const runFetch = () => void actions.fetch({ prune: prefs.fetchPrune })
  const runPull = () => void actions.pull({ rebase: prefs.pullRebase })
  const runPush = () => void (needsPublish ? actions.push({ setUpstream: true }) : actions.push())
  const runSync = () => void actions.sync()
  const runIntent: Record<SyncIntent, () => void> = {
    publish: runPush,
    sync: runSync,
    pull: runPull,
    push: runPush,
    fetch: runFetch,
  }
  const intentCommand: Record<SyncIntent, string> = {
    publish: "git_push",
    sync: "git_sync",
    pull: "git_pull",
    push: "git_push",
    fetch: "git_fetch",
  }
  const remoteName = upstream ?? t("sync.theRemote")
  const intentDescription =
    intent === "publish"
      ? t("sync.describe.publish", { branch: branch ?? "" })
      : intent === "sync"
        ? t("sync.describe.sync", { behind, ahead, upstream: remoteName })
        : intent === "pull"
          ? t("sync.describe.pull", { count: behind, upstream: remoteName })
          : intent === "push"
            ? t("sync.describe.push", { count: ahead, upstream: remoteName })
            : upstream
              ? t("sync.describe.fetchUpToDate", { upstream })
              : t("sync.describe.fetch")
  const IntentIcon = INTENT_ICON[intent]

  const runForcePush = () => void actions.push({ forceWithLease: true })
  const requestForcePush = () => {
    if (prefs.confirmForcePush) setConfirmForcePush(true)
    else runForcePush()
  }
  // Untracked files included, the same as the Changes group's "Discard All".
  // One label with two meanings is how a user who reached for one of them got
  // the other; the confirmation says untracked files go too.
  const runDiscardAll = () => void actions.discardAll(true)
  const requestDiscardAll = () => {
    if (prefs.confirmDiscard) setConfirmDiscardAll(true)
    else runDiscardAll()
  }

  return (
    <div className="flex items-center gap-1" data-testid="sync-toolbar">
      <ButtonGroup>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              aria-label={intentDescription}
              disabled={networkBusy || !can(intentCommand[intent])}
              onClick={runIntent[intent]}
              data-testid="sync-primary"
              data-intent={intent}
            >
              {networkBusy ? (
                <Spinner className="size-3.5" />
              ) : (
                <IntentIcon aria-hidden className="size-3.5" />
              )}
              {!dense && <span>{t(`sync.intent.${intent}`)}</span>}
              {(intent === "pull" || intent === "sync") && (
                <span
                  className="flex items-center tabular-nums text-muted-foreground"
                  data-testid="sync-behind"
                >
                  <ArrowDownIcon aria-hidden className="size-3" />
                  {behind}
                </span>
              )}
              {(intent === "push" || intent === "sync") && (
                <span
                  className="flex items-center tabular-nums text-muted-foreground"
                  data-testid="sync-ahead"
                >
                  <ArrowUpIcon aria-hidden className="size-3" />
                  {ahead}
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{intentDescription}</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-1.5"
              aria-label={t("sync.menu")}
              data-testid="sync-menu"
            >
              <ChevronDownIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {upstream ? t("sync.trackingLabel", { upstream }) : t("sync.noUpstreamLabel")}
            </DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={ops.fetch || !can("git_fetch")}
                onSelect={runFetch}
                data-testid="sync-fetch"
              >
                <CloudDownloadIcon className="size-3.5" />
                <span className="flex-1">{t("actions.fetch")}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={ops.pull || !can("git_pull")}
                onSelect={runPull}
                data-testid="sync-pull"
              >
                <ArrowDownToLineIcon className="size-3.5" />
                <span className="flex-1">{t("actions.pull")}</span>
                {behind > 0 && <MenuCount>{behind}</MenuCount>}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={ops.push || !can("git_push")}
                onSelect={runPush}
                data-testid={needsPublish ? "sync-publish" : "sync-push"}
              >
                {needsPublish ? (
                  <UploadCloudIcon className="size-3.5" />
                ) : (
                  <ArrowUpFromLineIcon className="size-3.5" />
                )}
                <span className="flex-1">
                  {needsPublish ? t("actions.publish") : t("actions.push")}
                </span>
                {!needsPublish && ahead > 0 && <MenuCount>{ahead}</MenuCount>}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={ops.sync || !can("git_sync")}
                onSelect={runSync}
                data-testid="sync-sync"
              >
                <RefreshCwIcon className="size-3.5" />
                <span className="flex-1">{t("actions.sync")}</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={!can("git_pull")}
                onSelect={() => void actions.pull({ rebase: true })}
                data-testid="more-pull-rebase"
              >
                <ArrowDownToLineIcon className="size-3.5" />
                {t("actions.pullRebase")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!can("git_fetch")}
                onSelect={() => void actions.fetch({ prune: true })}
                data-testid="more-fetch-prune"
              >
                <ScissorsIcon className="size-3.5" />
                {t("actions.fetchPrune")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={!canForcePush || !can("git_push")}
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
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                aria-label={t("actions.more")}
                data-testid="sync-more"
              >
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("actions.more")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56">
          {/* preventDefault on overlay-opening items: opening a Sheet from a
              closing menu races Radix focus restore (sticky pointer-events). */}
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {t("tools.repository")}
          </DropdownMenuLabel>
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={!can("git_log")}
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
              disabled={!can("git_stash_list")}
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
              disabled={!can("git_diff_refs_files")}
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
              disabled={!can("git_remotes")}
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
              disabled={!can("git_tags")}
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
              disabled={!can("git_worktree_list")}
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
              disabled={!can("git_stack_validate")}
              onSelect={(e) => {
                e.preventDefault()
                onOpenStacks()
              }}
              data-testid="more-stacks"
            >
              <LayersIcon className="size-3.5" />
              {t("stacks.title")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {t("tools.commits")}
          </DropdownMenuLabel>
          <DropdownMenuGroup>
            <DropdownMenuItem
              onSelect={() => void actions.reset("soft", "HEAD~1")}
              disabled={sequencerBusy || !can("git_reset")}
              data-testid="more-undo-commit"
            >
              <Undo2Icon className="size-3.5" />
              {t("actions.undoLastCommit")}
            </DropdownMenuItem>
            {isMerging && (
              <DropdownMenuItem
                disabled={!can("git_merge_abort")}
                onSelect={() => void actions.mergeAbort()}
                data-testid="more-abort-merge"
              >
                <GitMergeIcon className="size-3.5" />
                {t("actions.abortMerge")}
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onRefresh} data-testid="more-refresh">
            <RefreshCwIcon className="size-3.5" />
            {t("actions.refresh")}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={!can("git_discard_all")}
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

/** A commit count on the right of a menu row. */
function MenuCount({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto text-xs tabular-nums text-muted-foreground">{children}</span>
}
