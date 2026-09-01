"use client"

/**
 * Current-branch chip with ahead and behind counts. Opens the `BranchPicker`.
 *
 * Four mounts now: the desktop Source Control panel, the artifacts workspace
 * overview, the phone's Source Control screen, and the shell's workspace
 * context bar. The last one is why `className` exists: the bar gives it a
 * segment rather than a header row, so the trigger has to be able to give up
 * its `max-w-[60%]` without a second copy of this chip existing to carry a
 * different width.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowDownIcon, ArrowUpIcon, GitBranchIcon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { GitBranch } from "@/types/git"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { BranchPicker } from "./branch-picker"

interface BranchHeaderProps {
  branch: string | null
  ahead: number
  behind: number
  branches: GitBranch[]
  actions: Pick<
    UseGitActionsResult,
    "checkout" | "createBranch" | "deleteBranch" | "renameBranch" | "rebase" | "merge"
  > &
    Partial<Pick<UseGitActionsResult, "can">>
  /** Applied to the trigger, for a host that sizes its own segments. */
  className?: string
  /** Where the picker opens. Defaults to below the trigger. */
  side?: "top" | "bottom"
}

export function BranchHeader({
  branch,
  ahead,
  behind,
  branches,
  actions,
  className,
  side = "bottom",
}: BranchHeaderProps) {
  const t = useTranslations("sourceControl")
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-7 max-w-[60%] gap-1.5 px-2", className)}
          data-testid="branch-header"
          aria-label={t("branches.switch")}
          disabled={actions.can ? !actions.can("git_branches") : false}
        >
          <GitBranchIcon className="size-3.5 shrink-0" />
          <span className="truncate">{branch ?? t("branches.detached")}</span>
          {behind > 0 && (
            <span className="flex items-center text-[10px] text-muted-foreground">
              <ArrowDownIcon className="size-2.5" />
              {behind}
            </span>
          )}
          {ahead > 0 && (
            <span className="flex items-center text-[10px] text-muted-foreground">
              <ArrowUpIcon className="size-2.5" />
              {ahead}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side={side} className="w-72 p-0">
        <BranchPicker branches={branches} actions={actions} onPicked={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}
