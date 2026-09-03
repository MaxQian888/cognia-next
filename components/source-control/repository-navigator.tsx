"use client"

/**
 * Repository, worktrees, branches, stacks: one hierarchical inventory.
 *
 * These were the three most structural things in Source Control and the three
 * least reachable. Worktrees and stacks lived two clicks deep inside the sync
 * toolbar's overflow menu, each opening a Sheet over the diff, while the
 * branch list lived in a 288px popover hanging off the header chip. Fetch and
 * pull, which are one-tap habits, had top-level buttons. The inversion is the
 * bug: every modern client (VS Code, Fork, Sublime Merge, GitKraken) puts
 * repository, worktree and branch in one navigator, because they are what you
 * move BETWEEN, not what you do.
 *
 * Nothing here is re-modelled. The worktree inventory is
 * `WorkspaceEnvironmentList`, which `/workspace` also mounts and which already
 * degrades to cards below 640px on its own measured width. The branch list is
 * `BranchPicker`, mounted inline instead of inside a popover. The stack chain
 * is `StackList`. Each keeps its own reads, so this file owns layout and which
 * section is open, and no third copy of any of them exists to drift.
 *
 * Sections read only while open, which is why `active` is threaded down: this
 * column is mounted for the whole life of the panel, and three lists that each
 * shelled out to git on every render would cost more than the panel does.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon, LayersIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { NewWorktreeForm } from "@/components/workspace/new-worktree-form"
import { WorkspaceEnvironmentList } from "@/components/workspace/workspace-environment-list"
import type { GitBranch } from "@/types/git"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"

import { BranchPicker } from "./branch-picker"
import { StackList } from "./stack-list"

/** Which section of the navigator is open. One at a time, so the column reads. */
export type NavigatorSection = "worktrees" | "branches" | "stacks"

export interface RepositoryNavigatorProps {
  rootDir: string
  branches: GitBranch[]
  actions: Pick<
    UseGitActionsResult,
    "checkout" | "createBranch" | "deleteBranch" | "renameBranch" | "rebase" | "merge"
  > &
    Partial<Pick<UseGitActionsResult, "can">>
  /** Gate for the worktree inventory's own writes. */
  canMutate?: (command: string) => boolean
  /** Injected in tests. Production takes the hooks' own defaults. */
  stackDeps?: React.ComponentProps<typeof StackList>["deps"]
  stackForgeDeps?: React.ComponentProps<typeof StackList>["forgeDeps"]
}

interface SectionProps {
  id: NavigatorSection
  label: string
  icon: React.ReactNode
  count?: number
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}

function NavigatorSectionHeader({
  id,
  label,
  icon,
  count,
  open,
  onToggle,
  children,
}: SectionProps) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon
  return (
    <section data-testid={`navigator-section-${id}`} data-open={open ? "true" : "false"}>
      <div className="flex h-7 items-center gap-1 px-1">
        <Button
          type="button"
          variant="ghost"
          onClick={onToggle}
          aria-expanded={open}
          className="h-auto min-w-0 flex-1 justify-start gap-1 rounded px-1 py-0 text-[11px] uppercase tracking-wide text-muted-foreground"
          data-testid={`navigator-toggle-${id}`}
        >
          <Chevron aria-hidden className="size-3 shrink-0" />
          {icon}
          <span className="min-w-0 truncate">{label}</span>
        </Button>
        {count !== undefined && (
          <Badge variant="secondary" className="shrink-0 text-[10px] font-normal tabular-nums">
            {count}
          </Badge>
        )}
      </div>
      {open ? <div className="pb-2">{children}</div> : null}
    </section>
  )
}

export function RepositoryNavigator({
  rootDir,
  branches,
  actions,
  canMutate,
  stackDeps,
  stackForgeDeps,
}: RepositoryNavigatorProps) {
  const t = useTranslations("sourceControl")
  const [open, setOpen] = useState<NavigatorSection>("branches")
  // Bumped when a worktree is created, so the inventory below the form reloads
  // without the form knowing what the list reads.
  const [worktreeEpoch, setWorktreeEpoch] = useState(0)

  const toggle = (section: NavigatorSection) => () =>
    setOpen((current) => (current === section ? current : section))

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-1 p-1" data-testid="repository-navigator">
        <NavigatorSectionHeader
          id="branches"
          label={t("branches.title")}
          icon={<GitBranchIcon aria-hidden className="size-3 shrink-0" />}
          count={branches.length}
          open={open === "branches"}
          onToggle={toggle("branches")}
        >
          {/* The same list the header chip opens in a popover, without the
              popover. `w-72` is the popover's width and would pin this column
              open at 288px, so it is overridden here rather than parameterised
              on the picker, which has four other mounts that all want it. */}
          <BranchPicker branches={branches} actions={actions} className="w-full" />
        </NavigatorSectionHeader>

        <NavigatorSectionHeader
          id="worktrees"
          label={t("worktrees.title")}
          icon={<GitBranchIcon aria-hidden className="size-3 shrink-0" />}
          open={open === "worktrees"}
          onToggle={toggle("worktrees")}
        >
          <div className="flex flex-col gap-2 px-1">
            <NewWorktreeForm
              rootDir={rootDir}
              canMutate={canMutate}
              onCreated={() => setWorktreeEpoch((epoch) => epoch + 1)}
            />
            <WorkspaceEnvironmentList
              presentation="sheet"
              rootDir={rootDir}
              refreshKey={worktreeEpoch}
              showPrune
              canMutate={canMutate}
            />
          </div>
        </NavigatorSectionHeader>

        <NavigatorSectionHeader
          id="stacks"
          label={t("stacks.title")}
          icon={<LayersIcon aria-hidden className="size-3 shrink-0" />}
          open={open === "stacks"}
          onToggle={toggle("stacks")}
        >
          <StackList
            active={open === "stacks"}
            rootDir={rootDir}
            branches={branches}
            className="max-h-[32rem]"
            {...(stackDeps ? { deps: stackDeps } : {})}
            {...(stackForgeDeps ? { forgeDeps: stackForgeDeps } : {})}
          />
        </NavigatorSectionHeader>
      </div>
    </ScrollArea>
  )
}
