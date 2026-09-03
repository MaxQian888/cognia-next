"use client"

/**
 * `/source-control` on a phone.
 *
 * The desktop panel is a `ResizablePanelGroup`: changes on the left, diff on
 * the right. Two resizable panes in 375px is not a layout, it is two unusable
 * columns, which is why this route had no compact branch and rendered the
 * split anyway.
 *
 * Nothing about git is re-modelled. `BranchHeader`, `ChangesView`, `CommitBox`
 * and `DiffPane` are the same components the desktop renders, reading the same
 * `useGitStore` and driven by the same `useGitActions`, so a file can never be
 * staged here and unstaged there. What changes is only which of them is on
 * screen: the change list IS the page, and the diff arrives as a drawer when a
 * file is tapped.
 *
 * `density="touch"` on both list and diff, which those components already
 * support for the chat dock's narrow pane. The stage / unstage / discard
 * targets grow, and the diff drops to a single-column hunk view.
 *
 * `variant="review"` rather than `"panel"`, because `"panel"` is what makes
 * `ChangesView` render a `CommitBox` of its own at the TOP of the list. This
 * screen pins its own at the bottom, and passing `"panel"` put two live commit
 * boxes on the page: same draft, separate sign-off, identity-dialog and
 * history state, either one able to commit.
 *
 * Deliberately absent: the stash, timeline, remotes, tags, compare, worktree
 * and stack dialogs the desktop `SyncToolbar` opens. Each is its own
 * multi-pane surface, and offering a trigger that opens an unusable dialog is
 * worse than not offering it. Pull, push and refresh are here, carrying their
 * ahead and behind counts, because they are one-tap actions and "is there
 * anything to pull" is the reason to open git on a phone at all.
 *
 * Worktrees and stacks are no longer among the omissions. They were a link out
 * to `/workspace?tab=environments` while the only way to show them here was the
 * desktop worktree sheet, whose table has nowhere to go at 375px. The
 * repository navigator does not have that problem: its inventory degrades to
 * cards below 640px on its own measured width, and a stack renders as a
 * vertical chain. So the phone gets the same two views the desktop panel
 * offers, and the change list stays the one it opens on.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  FolderOpenIcon,
  GitBranchIcon,
  RefreshCwIcon,
} from "lucide-react"

import { BranchHeader } from "@/components/source-control/branch-header"
import { RepositoryNavigator } from "@/components/source-control/repository-navigator"
import { ChangesView } from "@/components/source-control/changes-view"
import { CommitBox } from "@/components/source-control/commit-box"
import { DiffPane } from "@/components/source-control/diff-pane"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useGitActions } from "@/hooks/git/use-git-actions"
import { useGitRepo } from "@/hooks/git/use-git-repo"
import { useGitStore } from "@/stores/git/git-store"

export function SourceControlMobileBody() {
  const t = useTranslations("sourceControl")
  const { available, rootDir, refresh, openFolder, remote } = useGitRepo()
  const actions = useGitActions(refresh)
  const can = actions.can ?? (() => true)

  const repoState = useGitStore((s) => s.repoState)
  const status = useGitStore((s) => s.status)
  const branches = useGitStore((s) => s.branches)
  const selectedPath = useGitStore((s) => s.selectedPath)
  const selectedStaged = useGitStore((s) => s.selectedStaged)
  const selectFile = useGitStore((s) => s.selectFile)
  const committing = useGitStore((s) => s.ops.commit)

  /**
   * The diff opens on a tap, not on the store's selection.
   *
   * Selection survives navigation, and the desktop reopens on it, so deriving
   * "open" from it would pop the drawer every time the user returns to this
   * page. Same reasoning as `devices-mobile-body`.
   */
  const [diffOpen, setDiffOpen] = useState(false)
  // Which body: the change list, or the repository navigator. Same two views
  // the desktop panel offers, so a phone is not a different product.
  const [view, setView] = useState<"changes" | "browse">("changes")
  const onSelectFile = useCallback(
    (path: string, staged: boolean) => {
      selectFile(path, staged)
      setDiffOpen(true)
    },
    [selectFile]
  )

  if (!available) {
    return (
      <Empty className="h-full border-0" data-testid="sc-mobile-unavailable">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitBranchIcon />
          </EmptyMedia>
          <EmptyTitle>{t("desktopOnly.title")}</EmptyTitle>
          <EmptyDescription>{t("desktopOnly.description")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  if (!rootDir) {
    return (
      <Empty className="h-full border-0" data-testid="sc-mobile-no-folder">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderOpenIcon />
          </EmptyMedia>
          <EmptyTitle>
            {remote ? t("remote.noWorkspace") : t("emptyState.noFolder")}
          </EmptyTitle>
          {remote ? <EmptyDescription>{t("remote.noWorkspaceDescription")}</EmptyDescription> : null}
        </EmptyHeader>
        {/* A phone paired to a host has no folder picker of its own: the
            workspace is chosen on the machine holding the repository. Only the
            local case gets the button, and the remote case gets the sentence
            above instead of a control that would open nothing. */}
        {remote ? null : (
          <EmptyContent className="flex-row gap-2">
            <Button onClick={() => void openFolder()} data-testid="sc-mobile-open-folder">
              {t("emptyState.openFolder")}
            </Button>
          </EmptyContent>
        )}
      </Empty>
    )
  }

  if (repoState && !repoState.isRepo) {
    return (
      <Empty className="h-full border-0" data-testid="sc-mobile-not-a-repo">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitBranchIcon />
          </EmptyMedia>
          <EmptyDescription>{t("emptyState.notARepo")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const stagedCount = status?.staged.length ?? 0
  const ahead = status?.ahead ?? 0
  const behind = status?.behind ?? 0

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="source-control-mobile-body">
      <header className="safe-area-pt flex shrink-0 items-center gap-1 border-b px-2 py-2">
        <BranchHeader
          branch={status?.branch ?? null}
          ahead={ahead}
          behind={behind}
          branches={branches}
          actions={actions}
        />
        <div className="flex-1" />
        {/* Pull and push carry their counts, because on a phone the reason to
            open this screen is usually "is there anything to pull". */}
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1 px-2 text-xs"
          disabled={!can("git_pull")}
          aria-label={t("actions.pull")}
          onClick={() => void actions.pull()}
          data-testid="sc-mobile-pull"
        >
          <ArrowDownToLineIcon className="size-4" />
          {behind > 0 ? behind : null}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1 px-2 text-xs"
          disabled={!can("git_push")}
          aria-label={t("actions.push")}
          onClick={() => void actions.push()}
          data-testid="sc-mobile-push"
        >
          <ArrowUpFromLineIcon className="size-4" />
          {ahead > 0 ? ahead : null}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={t("actions.refresh")}
          onClick={() => void refresh()}
          data-testid="sc-mobile-refresh"
        >
          <RefreshCwIcon className="size-4" />
        </Button>
      </header>

      {/*
        Worktrees and stacks stopped being a link out. They are the navigator,
        and it is usable here: the worktree inventory degrades to cards below
        640px on its own measured width, and a stack renders as a vertical
        chain, which is the one shape a phone has room for.

        The rest of the desktop's dialogs stay deliberately absent, for the
        reason at the top of this file. A trigger that opens an unusable dialog
        is worse than not offering it.
      */}
      <div
        role="tablist"
        aria-label={t("views.label")}
        className="flex shrink-0 border-b"
        data-testid="sc-mobile-views"
      >
        {(["changes", "browse"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={view === candidate}
            onClick={() => setView(candidate)}
            className={cn(
              "min-h-11 flex-1 px-3 text-xs text-muted-foreground active:bg-accent",
              view === candidate && "border-b-2 border-primary font-medium text-foreground"
            )}
            data-testid={`sc-mobile-view-${candidate}`}
          >
            {t(`views.${candidate}`)}
          </button>
        ))}
      </div>

      {view === "browse" ? (
        <div className="min-h-0 flex-1">
          <RepositoryNavigator
            rootDir={rootDir}
            branches={branches}
            actions={actions}
            canMutate={actions.can}
          />
        </div>
      ) : (
        <>
          {/* `status` is null until the first load resolves, and `ChangesView`
              requires it. The desktop panel guards the same way rather than
              rendering an empty list that reads as "no changes". */}
          {status ? (
            <PullToRefresh onRefresh={refresh} className="min-h-0 flex-1">
              <ChangesView
                variant="review"
                density="touch"
                rootDir={rootDir}
                status={status}
                actions={actions}
                committing={committing}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
              />
            </PullToRefresh>
          ) : (
            <div className="min-h-0 flex-1 px-3 py-6" data-testid="sc-mobile-loading">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-3 h-4 w-full" />
              <Skeleton className="mt-2 h-4 w-2/3" />
            </div>
          )}

          {/* The commit box is pinned rather than scrolled to. It is the one
              action the screen exists for, and a message field that walks off
              the bottom of a list is a field nobody finds. */}
          {status ? (
            <div className="shrink-0 border-t px-2 py-2">
              <CommitBox
                rootDir={rootDir}
                stagedCount={stagedCount}
                committing={committing}
                actions={actions}
              />
            </div>
          ) : null}
        </>
      )}

      <ResponsiveDetailSheet
        open={diffOpen && Boolean(selectedPath)}
        onOpenChange={setDiffOpen}
        title={selectedPath ?? t("title")}
      >
        {/* The drawer caps itself at 85vh and `DiffPane` is `h-full` with its
            own scroller, so a bounded box between the two gives that scroller
            something definite to resolve against. */}
        <div className="h-[68vh] min-h-0">
          {selectedPath ? (
            <DiffPane
              rootDir={rootDir}
              path={selectedPath}
              staged={selectedStaged}
              actions={actions}
              density="touch"
            />
          ) : null}
        </div>
      </ResponsiveDetailSheet>
    </div>
  )
}
