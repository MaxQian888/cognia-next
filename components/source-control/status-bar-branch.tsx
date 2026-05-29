"use client"

/**
 * StatusBar branch + sync indicator. The always-mounted owner of the git fs
 * watcher (via `useGitBranchIndicator`). Shows the current branch, ahead/behind
 * counts, and a sync spinner; clicking navigates to the Source Control panel.
 */

import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { ArrowDownIcon, ArrowUpIcon, GitBranchIcon, RefreshCwIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useGitBranchIndicator } from "@/hooks/git/use-git-branch-indicator"

export function StatusBarBranch() {
  const t = useTranslations("sourceControl")
  const router = useRouter()
  const { available, branch, ahead, behind, busy } = useGitBranchIndicator()

  // Desktop-only and only when a branch is known.
  if (!available || !branch) return null

  return (
    <button
      type="button"
      onClick={() => router.push("/source-control")}
      aria-label={t("statusBar.openSourceControl")}
      title={t("statusBar.openSourceControl")}
      data-testid="status-branch"
      className="flex h-6 shrink-0 items-center gap-1 px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <GitBranchIcon aria-hidden className="size-3" />
      <span className="max-w-[16ch] truncate">{branch}</span>
      {behind > 0 && (
        <span className="flex items-center">
          <ArrowDownIcon aria-hidden className="size-2.5" />
          {behind}
        </span>
      )}
      {ahead > 0 && (
        <span className="flex items-center">
          <ArrowUpIcon aria-hidden className="size-2.5" />
          {ahead}
        </span>
      )}
      {busy && <RefreshCwIcon aria-hidden className={cn("size-2.5 animate-spin")} />}
    </button>
  )
}
