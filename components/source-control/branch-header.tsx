"use client"

/** Current-branch chip with ahead/behind counts; opens the BranchPicker. */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowDownIcon, ArrowUpIcon, GitBranchIcon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import type { GitBranch } from "@/lib/git/types"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { BranchPicker } from "./branch-picker"

interface BranchHeaderProps {
  branch: string | null
  ahead: number
  behind: number
  branches: GitBranch[]
  actions: Pick<UseGitActionsResult, "checkout" | "createBranch" | "deleteBranch" | "renameBranch">
}

export function BranchHeader({ branch, ahead, behind, branches, actions }: BranchHeaderProps) {
  const t = useTranslations("sourceControl")
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 max-w-[60%] gap-1.5 px-2"
          data-testid="branch-header"
          aria-label={t("branches.switch")}
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
      <PopoverContent align="start" className="w-72 p-0">
        <BranchPicker branches={branches} actions={actions} onPicked={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}
