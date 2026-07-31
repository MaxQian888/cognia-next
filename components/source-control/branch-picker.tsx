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
  >
  onPicked?: () => void
}

export function BranchPicker({ branches, actions, onPicked }: BranchPickerProps) {
  const t = useTranslations("sourceControl")
  const { prefs } = useSourceControlPrefs()
  const [mode, setMode] = useState<"create" | "rename">("create")
  const [name, setName] = useState("")

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
    if (mode === "create") await actions.createBranch(trimmed, true)
    else await actions.renameBranch(trimmed)
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
                  void actions.checkout(branch.name)
                  onPicked?.()
                }}
                className="flex items-center gap-2"
                data-testid={`branch-item-${branch.name}`}
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
                      void actions.merge(branch.name)
                      onPicked?.()
                    }}
                    data-testid={`branch-merge-${branch.name}`}
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
                      void actions.rebase(branch.name)
                      onPicked?.()
                    }}
                    data-testid={`branch-rebase-${branch.name}`}
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
          <button
            type="button"
            onClick={() => setMode("create")}
            className={cn("hover:underline", mode === "create" && "font-semibold text-foreground")}
            data-testid="branch-mode-create"
          >
            {t("branches.create")}
          </button>
          <button
            type="button"
            onClick={() => setMode("rename")}
            className={cn("hover:underline", mode === "rename" && "font-semibold text-foreground")}
            data-testid="branch-mode-rename"
          >
            {t("branches.rename")}
          </button>
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
            disabled={!name.trim()}
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
