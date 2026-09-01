"use client"

/**
 * Where you are: the workspace, and the branch inside it.
 *
 * The shell knew both facts and put them on opposite ends of the app. The
 * workspace switcher headed the sidebar, and the branch lived on the Source
 * Control page, so from a conversation you could not read which branch the
 * agent was about to commit on, and changing it meant leaving the conversation.
 * Zed, VS Code and Warp all keep this pair adjacent, and the reason is not
 * aesthetic: they are one answer to one question, and splitting them is how a
 * user ends up running a task against the wrong tree.
 *
 * Both segments are EXISTING components. `WorkspaceSwitcher` is the same
 * popover the rail and the phone drawer open, and `BranchHeader` is the same
 * chip the Source Control panel and the phone's git screen open, carrying the
 * same `BranchPicker` with checkout, create, delete and rename. This is a
 * second door onto one editor, which is fine. It is deliberately NOT a second
 * editor.
 *
 * The execution environment is deliberately absent. `SessionEnvironmentChip`
 * already sits in the chat header with the only route to the Local versus
 * managed-worktree editor, and a global copy of it would be the double-entry
 * defect this repo keeps re-learning. The gap this bar closes is the branch,
 * which had no door from a conversation at all.
 *
 * The branch segment is read-only about its own existence: it renders only
 * where Source Control can actually run and a repository is bound. A dead
 * `[no branch]` slot in permanent chrome teaches the user to stop reading the
 * bar, which costs more than the slot is worth.
 */

import { useCallback } from "react"
import { ChevronRightIcon } from "lucide-react"

import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher"
import { BranchHeader } from "@/components/source-control/branch-header"
import { useGitActions } from "@/hooks/git/use-git-actions"
import { isSourceControlUiAvailable } from "@/lib/git/commands"
import { loadGitRepo } from "@/lib/git/load"
import { useGitStore } from "@/stores/git/git-store"
import { cn } from "@/lib/utils"

export interface WorkspaceContextBarProps {
  /**
   * `bar` is the horizontal title-bar form, where the segments compete for a
   * strip whose width is the sidebar column's. `stacked` is the phone's, where
   * each segment gets its own full-width row inside a drawer.
   */
  layout?: "bar" | "stacked"
  className?: string
}

/**
 * The branch half, split out because it subscribes to the git store and the
 * workspace half does not. Keeping them in one component would re-render the
 * switcher on every status refresh.
 */
function BranchSegment({ layout }: { layout: "bar" | "stacked" }) {
  // Observe only. The fs watcher and the status subscription are owned by the
  // always-mounted `useGitBranchIndicator` in the status bar, and `useGitRepo`
  // is not used here on purpose: on a paired client it starts a 5 second poll,
  // which is a fair price for a page and not for permanent chrome.
  const available = isSourceControlUiAvailable()
  const rootDir = useGitStore((s) => s.rootDir)
  const status = useGitStore((s) => s.status)
  const branches = useGitStore((s) => s.branches)
  const refresh = useCallback(() => loadGitRepo(rootDir), [rootDir])
  const actions = useGitActions(refresh)

  if (!available || !rootDir || !status) return null

  return (
    <>
      {/*
        The separator belongs to the branch, not to the row. Drawn by the parent
        it would need to know whether this segment rendered, which is a fact
        only this component holds. Two chips with only whitespace between them
        also read as two unrelated controls, and the point of the bar is that
        the second one is INSIDE the first.
      */}
      {layout === "bar" ? (
        <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/50" />
      ) : null}
      <BranchHeader
        branch={status.branch ?? null}
        ahead={status.ahead ?? 0}
        behind={status.behind ?? 0}
        branches={branches}
        actions={actions}
        side={layout === "stacked" ? "top" : "bottom"}
        className={cn(
          // Give up width before the workspace name does. The workspace is the
          // coarser fact and the one a user orients by.
          layout === "bar"
            ? "min-w-0 max-w-[45%] shrink text-muted-foreground"
            : "w-full max-w-full justify-start"
        )}
      />
    </>
  )
}

export function WorkspaceContextBar({ layout = "bar", className }: WorkspaceContextBarProps) {
  if (layout === "stacked") {
    return (
      <div
        className={cn("flex w-full flex-col gap-1", className)}
        data-testid="workspace-context-bar"
        data-layout="stacked"
      >
        <BranchSegment layout="stacked" />
      </div>
    )
  }

  return (
    <div
      className={cn("flex min-w-0 flex-1 items-center gap-0.5", className)}
      data-testid="workspace-context-bar"
      data-layout="bar"
    >
      <WorkspaceSwitcher variant="wide" className="min-w-0" />
      <BranchSegment layout="bar" />
    </div>
  )
}

export default WorkspaceContextBar
