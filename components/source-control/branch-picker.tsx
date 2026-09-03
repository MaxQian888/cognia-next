"use client"

/**
 * Branch switcher: a Command list of local/remote branches.
 *
 * Every row used to offer the same checkout button and let git decide. That
 * is wrong twice over. Git refuses to move a branch a second worktree already
 * holds, and this application cuts those worktrees itself for isolated runs,
 * so the picker was offering a checkout it could have known would fail,
 * against worktrees of its own making. And `checkout origin/x` detaches HEAD
 * rather than doing what a person means by "switch to origin/x".
 *
 * So a row states where its branch lives and offers the action that fits:
 * checkout for a free branch, "open" for one another worktree holds, and
 * "track" for a remote-only ref. The verdict comes from
 * `lib/git/branch-placement`, shared with the palette so the two cannot
 * disagree.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitCompareArrowsIcon,
  GitMergeIcon,
  LayersIcon,
  LockIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { GitBranch } from "@/types/git"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { useSourceControlPrefs } from "@/hooks/git/use-source-control-prefs"
import { useGitStore } from "@/stores/git/git-store"
import {
  canDeleteBranch,
  describePlacement,
  isAgentBranch,
  primaryActionFor,
  stackParentIndex,
  worktreeLabel,
  worktreeTargetFor,
  type BranchPlacement,
} from "@/lib/git/branch-placement"

interface BranchPickerProps {
  branches: GitBranch[]
  actions: Pick<
    UseGitActionsResult,
    "checkout" | "createBranch" | "deleteBranch" | "renameBranch" | "rebase" | "merge"
  > &
    Partial<Pick<UseGitActionsResult, "can">>
  onPicked?: () => void
  /**
   * Applied to the outer column. `w-72` is the popover's width, which four
   * mounts want and the navigator does not: inside a resizable column it would
   * pin that column open at 288px.
   */
  className?: string
}

/** A branch whose row has already been decided. */
interface BranchRow {
  branch: GitBranch
  placement: BranchPlacement
  stackParent: string | null
  isAgent: boolean
}

export function BranchPicker({ branches, actions, onPicked, className }: BranchPickerProps) {
  const t = useTranslations("sourceControl")
  const { prefs } = useSourceControlPrefs()
  const rootDir = useGitStore((s) => s.rootDir)
  const setRootDir = useGitStore((s) => s.setRootDir)
  const stackParents = useGitStore((s) => s.stackParents)
  const [mode, setMode] = useState<"create" | "rename">("create")
  const [name, setName] = useState("")
  // A `branch -d` that git refused as unmerged. Escalating to `-D` is a
  // different, destructive decision, so it is asked rather than retried.
  const [forceDelete, setForceDelete] = useState<string | null>(null)
  // Memoised, not inline: `primaryDisabled` closes over it, and a fresh
  // fallback identity every render would rebuild that callback each time.
  const can = useMemo(() => actions.can ?? (() => true), [actions])

  const rows = useMemo<BranchRow[]>(() => {
    const parents = stackParentIndex(stackParents)
    const ordered =
      prefs.branchSort === "name"
        ? [...branches].sort((a, b) => a.name.localeCompare(b.name))
        : branches
    return ordered.map((branch) => ({
      branch,
      placement: describePlacement(branch),
      stackParent: parents.get(branch.name) ?? null,
      isAgent: isAgentBranch(branch.name),
    }))
  }, [branches, prefs.branchSort, stackParents])

  const openWorktree = useCallback(
    (path: string) => {
      if (!rootDir) return
      setRootDir(worktreeTargetFor(rootDir, path))
      onPicked?.()
    },
    [rootDir, setRootDir, onPicked]
  )

  const runPrimary = useCallback(
    (row: BranchRow) => {
      const action = primaryActionFor(row.placement)
      if (action === "none") return
      if (action === "openWorktree") {
        if (row.placement.kind === "otherWorktree") openWorktree(row.placement.path)
        return
      }
      if (action === "createTracking") {
        if (row.placement.kind !== "remoteOnly") return
        // `checkout origin/x` detaches HEAD. `checkout -b x origin/x` is what
        // the row means, and it sets the upstream on the way.
        void actions
          .createBranch(row.placement.shortName, true, row.branch.name)
          .then((failure) => {
            if (!failure) onPicked?.()
          })
        return
      }
      void actions.checkout(row.branch.name).then((failure) => {
        if (!failure) onPicked?.()
      })
    },
    [actions, openWorktree, onPicked]
  )

  const primaryDisabled = useCallback(
    (row: BranchRow) => {
      switch (primaryActionFor(row.placement)) {
        case "none":
          return true
        // A rebind is not a git mutation, so it needs no command permission.
        case "openWorktree":
          return false
        case "createTracking":
          return !can("git_create_branch")
        case "checkout":
          return !can("git_checkout_branch")
      }
    },
    [can]
  )

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const failure =
      mode === "create"
        ? await actions.createBranch(trimmed, true)
        : await actions.renameBranch(trimmed)
    if (failure) return
    setName("")
    onPicked?.()
  }

  const requestDelete = (branchName: string) => {
    void actions.deleteBranch(branchName, false).then((failure) => {
      // Git refuses an unmerged branch. That is a question, not a dead end.
      if (failure?.kind === "branchNotFullyMerged") setForceDelete(branchName)
    })
  }

  return (
    <div className={cn("flex w-72 flex-col", className)} data-testid="branch-picker">
      <Command>
        <CommandInput placeholder={t("branches.search")} />
        <CommandList>
          <CommandEmpty>{t("branches.empty")}</CommandEmpty>
          <CommandGroup>
            {rows.map((row) => (
              <BranchRowItem
                key={`${row.branch.isRemote ? "r" : "l"}:${row.branch.name}`}
                row={row}
                can={can}
                disabled={primaryDisabled(row)}
                onPrimary={() => runPrimary(row)}
                onMerge={() => {
                  void actions.merge(row.branch.name).then((failure) => {
                    if (!failure) onPicked?.()
                  })
                }}
                onRebase={() => {
                  void actions.rebase(row.branch.name).then((failure) => {
                    if (!failure) onPicked?.()
                  })
                }}
                onDelete={() => requestDelete(row.branch.name)}
              />
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
      <div className="border-t p-2">
        <div className="mb-1 flex gap-2 text-[11px]">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setMode("create")}
            aria-pressed={mode === "create"}
            className={cn("h-6 px-1 text-[11px]", mode === "create" && "bg-accent")}
            data-testid="branch-mode-create"
          >
            {t("branches.create")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setMode("rename")}
            aria-pressed={mode === "rename"}
            className={cn("h-6 px-1 text-[11px]", mode === "rename" && "bg-accent")}
            data-testid="branch-mode-rename"
          >
            {t("branches.rename")}
          </Button>
        </div>
        <div className="flex gap-1">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder={mode === "create" ? t("branches.newName") : t("branches.renameTo")}
            className="h-7 text-xs"
            data-testid="branch-name-input"
          />
          <Button
            size="icon"
            className="size-7 shrink-0"
            disabled={
              !name.trim() || !can(mode === "create" ? "git_create_branch" : "git_rename_branch")
            }
            onClick={() => void submit()}
            aria-label={mode === "create" ? t("branches.create") : t("branches.rename")}
            data-testid="branch-submit"
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <AlertDialog
        open={forceDelete !== null}
        onOpenChange={(open) => !open && setForceDelete(null)}
      >
        <AlertDialogContent data-testid="branch-force-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("branches.forceDeleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("branches.forceDeleteDescription", { name: forceDelete ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const target = forceDelete
                setForceDelete(null)
                if (target) void actions.deleteBranch(target, true)
              }}
              data-testid="branch-force-delete-action"
            >
              {t("branches.forceDeleteAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface BranchRowItemProps {
  row: BranchRow
  can: (command: string) => boolean
  disabled: boolean
  onPrimary: () => void
  onMerge: () => void
  onRebase: () => void
  onDelete: () => void
}

function BranchRowItem({
  row,
  can,
  disabled,
  onPrimary,
  onMerge,
  onRebase,
  onDelete,
}: BranchRowItemProps) {
  const t = useTranslations("sourceControl")
  const { branch, placement } = row
  const action = primaryActionFor(placement)

  const label =
    action === "openWorktree" && placement.kind === "otherWorktree"
      ? t("branches.openWorktree", { name: worktreeLabel(placement.path) })
      : action === "createTracking"
        ? t("branches.createTracking")
        : t("branches.switch")

  return (
    <CommandItem
      value={branch.name}
      onSelect={onPrimary}
      className="flex flex-col items-stretch gap-0.5"
      data-testid={`branch-item-${branch.name}`}
      data-placement={placement.kind}
      disabled={disabled}
      aria-label={label}
    >
      <div className="flex w-full items-center gap-2">
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn("min-w-0 flex-1 truncate", branch.isCurrent && "font-semibold")}>
          {branch.name}
        </span>
        {/*
          `title` rather than a Tooltip: the rest of this row already labels
          its controls that way, and a Tooltip would put the picker behind a
          TooltipProvider that four of its mounts do not supply.
        */}
        {row.isAgent && (
          <BotIcon
            className="size-3 shrink-0 text-muted-foreground"
            aria-label={t("branches.agentBranch")}
            role="img"
            data-testid={`branch-agent-${branch.name}`}
          >
            <title>{t("branches.agentBranch")}</title>
          </BotIcon>
        )}
        {branch.behind > 0 && (
          <span className="flex shrink-0 items-center text-[10px] text-muted-foreground">
            <ArrowDownIcon className="size-2.5" />
            {branch.behind}
          </span>
        )}
        {branch.ahead > 0 && (
          <span className="flex shrink-0 items-center text-[10px] text-muted-foreground">
            <ArrowUpIcon className="size-2.5" />
            {branch.ahead}
          </span>
        )}
        {!branch.isCurrent && (
          <Button
            variant="ghost"
            size="icon"
            className="size-5 shrink-0 text-muted-foreground"
            aria-label={t("sequencer.mergeInto")}
            title={t("sequencer.mergeInto")}
            onClick={(e) => {
              e.stopPropagation()
              onMerge()
            }}
            data-testid={`branch-merge-${branch.name}`}
            disabled={!can("git_merge")}
          >
            <GitMergeIcon className="size-3" />
          </Button>
        )}
        {!branch.isCurrent && (
          <Button
            variant="ghost"
            size="icon"
            className="size-5 shrink-0 text-muted-foreground"
            aria-label={t("sequencer.rebaseOnto")}
            title={t("sequencer.rebaseOnto")}
            onClick={(e) => {
              e.stopPropagation()
              onRebase()
            }}
            data-testid={`branch-rebase-${branch.name}`}
            disabled={!can("git_rebase")}
          >
            <GitCompareArrowsIcon className="size-3" />
          </Button>
        )}
        {/*
          Delete is offered only where git would accept it. A branch a worktree
          holds, and a remote-tracking ref, both refuse `branch -d`, and a
          button that always fails is worse than no button.
        */}
        {canDeleteBranch(branch) && (
          <Button
            variant="ghost"
            size="icon"
            className="size-5 shrink-0 text-destructive"
            aria-label={t("branches.delete")}
            title={t("branches.delete")}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            data-testid={`branch-delete-${branch.name}`}
            disabled={!can("git_delete_branch")}
          >
            <Trash2Icon className="size-3" />
          </Button>
        )}
      </div>

      <BranchRowMeta row={row} />
    </CommandItem>
  )
}

/** The second line: where the branch lives, what it tracks, which stack. */
function BranchRowMeta({ row }: { row: BranchRow }) {
  const t = useTranslations("sourceControl")
  const { branch, placement } = row
  const parts: React.ReactNode[] = []

  if (placement.kind === "otherWorktree") {
    parts.push(
      <span
        key="where"
        className="flex min-w-0 items-center gap-0.5"
        data-testid={`branch-where-${branch.name}`}
      >
        <ExternalLinkIcon className="size-2.5 shrink-0" />
        <span className="truncate">
          {t("branches.inWorktree", { name: worktreeLabel(placement.path) })}
        </span>
        {placement.locked && <LockIcon className="size-2.5 shrink-0" />}
      </span>
    )
  } else if (placement.kind === "remoteOnly") {
    parts.push(
      <span key="where" data-testid={`branch-where-${branch.name}`}>
        {t("branches.remote")}
      </span>
    )
  } else if (branch.upstream) {
    parts.push(
      <span key="where" className="min-w-0 truncate">
        {branch.upstream}
      </span>
    )
  } else if (!branch.isRemote) {
    parts.push(<span key="where">{t("branches.noUpstream")}</span>)
  }

  if (row.stackParent) {
    parts.push(
      <span
        key="stack"
        className="flex shrink-0 items-center gap-0.5"
        data-testid={`branch-stack-${branch.name}`}
      >
        <LayersIcon className="size-2.5" />
        {t("branches.stackParent", { name: row.stackParent })}
      </span>
    )
  }

  if (parts.length === 0) return null
  return (
    <div className="flex min-w-0 items-center gap-2 pl-5 text-[10px] text-muted-foreground">
      {parts}
    </div>
  )
}
