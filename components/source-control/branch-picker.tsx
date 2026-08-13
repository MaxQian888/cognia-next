"use client"

/**
 * Branch switcher: a Command list of local/remote branches with checkout,
 * create (+checkout), delete, and rename-current. Opened from the BranchHeader.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  GitBranchIcon,
  GitCompareArrowsIcon,
  GitMergeIcon,
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { GitBranch } from "@/types/git"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { useSourceControlPrefs } from "@/hooks/git/use-source-control-prefs"

interface BranchPickerProps {
  branches: GitBranch[]
  actions: Pick<
    UseGitActionsResult,
    "checkout" | "createBranch" | "deleteBranch" | "renameBranch" | "rebase" | "merge"
  > &
    Partial<Pick<UseGitActionsResult, "can">>
  onPicked?: () => void
}

export function BranchPicker({ branches, actions, onPicked }: BranchPickerProps) {
  const t = useTranslations("sourceControl")
  const { prefs } = useSourceControlPrefs()
  const [mode, setMode] = useState<"create" | "rename">("create")
  const [name, setName] = useState("")
  const can = actions.can ?? (() => true)

  // Order per the branch-sort preference; "default" keeps the backend order.
  const orderedBranches = useMemo(
    () =>
      prefs.branchSort === "name"
        ? [...branches].sort((a, b) => a.name.localeCompare(b.name))
        : branches,
    [branches, prefs.branchSort]
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

  return (
    <div className="flex w-72 flex-col" data-testid="branch-picker">
      <Command>
        <CommandInput placeholder={t("branches.search")} />
        <CommandList>
          <CommandEmpty>{t("branches.empty")}</CommandEmpty>
          <CommandGroup>
            {orderedBranches.map((branch) => (
              <CommandItem
                key={`${branch.isRemote ? "r" : "l"}:${branch.name}`}
                value={branch.name}
                onSelect={() => {
                  void actions.checkout(branch.name).then((failure) => {
                    if (!failure) onPicked?.()
                  })
                }}
                className="flex items-center gap-2"
                data-testid={`branch-item-${branch.name}`}
                disabled={!can("git_checkout_branch")}
              >
                <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span
                  className={cn("min-w-0 flex-1 truncate", branch.isCurrent && "font-semibold")}
                >
                  {branch.name}
                </span>
                {branch.isRemote && (
                  <span className="text-[10px] text-muted-foreground">{t("branches.remote")}</span>
                )}
                {!branch.isCurrent && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5 text-muted-foreground"
                    aria-label={t("sequencer.mergeInto")}
                    title={t("sequencer.mergeInto")}
                    onClick={(e) => {
                      e.stopPropagation()
                      void actions.merge(branch.name).then((failure) => {
                        if (!failure) onPicked?.()
                      })
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
                    className="size-5 text-muted-foreground"
                    aria-label={t("sequencer.rebaseOnto")}
                    title={t("sequencer.rebaseOnto")}
                    onClick={(e) => {
                      e.stopPropagation()
                      void actions.rebase(branch.name).then((failure) => {
                        if (!failure) onPicked?.()
                      })
                    }}
                    data-testid={`branch-rebase-${branch.name}`}
                    disabled={!can("git_rebase")}
                  >
                    <GitCompareArrowsIcon className="size-3" />
                  </Button>
                )}
                {!branch.isRemote && !branch.isCurrent && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5 text-destructive"
                    aria-label={t("branches.delete")}
                    title={t("branches.delete")}
                    onClick={(e) => {
                      e.stopPropagation()
                      void actions.deleteBranch(branch.name, false)
                    }}
                    data-testid={`branch-delete-${branch.name}`}
                    disabled={!can("git_delete_branch")}
                  >
                    <Trash2Icon className="size-3" />
                  </Button>
                )}
              </CommandItem>
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
    </div>
  )
}
