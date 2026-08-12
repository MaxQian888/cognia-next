"use client"

/**
 * Compact source-control panel for the Context Workbench.
 *
 * Shows the current branch, changed file list (staged + unstaged) with inline
 * stage/unstage/discard actions, and a quick commit message box. For the full
 * source-control experience (diff viewer, timeline, blame), use `/source-control`.
 *
 * Desktop-only: the panel requires the Tauri git backend.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { GitBranchIcon, ExternalLinkIcon, CheckIcon, MinusIcon, Undo2Icon } from "lucide-react"
import Link from "next/link"
import type { GitFileChange } from "@/types/git"
import { useGitStore, useGitStatus } from "@/stores/git/git-store"
import { useGitActions } from "@/hooks/git/use-git-actions"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { splitPath, statusDecoration } from "@/components/source-control/status-decoration"

export interface SourceControlWorkbenchPanelProps {
  /** Refresh callback from the host (calls the backend to re-fetch status). */
  onRefresh?: () => Promise<void>
}

export function SourceControlWorkbenchPanel({ onRefresh }: SourceControlWorkbenchPanelProps) {
  const t = useTranslations("contextWorkbench.sourceControlPanel")
  const status = useGitStatus()
  const rootDir = useGitStore((s) => s.rootDir)
  const commitDraft = useGitStore((s) => (rootDir ? (s.commitDraft[rootDir] ?? "") : ""))
  const setCommitDraft = useGitStore((s) => s.setCommitDraft)
  const isCommitting = useGitStore((s) => s.ops.commit)

  const refresh = useCallback(async () => {
    if (onRefresh) await onRefresh()
  }, [onRefresh])

  const actions = useGitActions(refresh)

  const stagedCount = status?.staged.length ?? 0
  const changedCount = status?.changes.length ?? 0
  const totalCount = stagedCount + changedCount

  const handleCommit = useCallback(async () => {
    if (!commitDraft.trim() || stagedCount === 0) return
    await actions.commit(commitDraft.trim())
    if (rootDir) setCommitDraft(rootDir, "")
  }, [actions, commitDraft, rootDir, setCommitDraft, stagedCount])

  if (!status) {
    return (
      <Empty className="h-full rounded-none">
        <EmptyMedia variant="icon">
          <GitBranchIcon />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{t("noRepo")}</EmptyTitle>
        <EmptyDescription className="text-xs">{t("noRepoDescription")}</EmptyDescription>
      </Empty>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Branch header */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <GitBranchIcon className="size-3.5 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{status.branch ?? t("detached")}</span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="text-xs text-muted-foreground">
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {t("changeCount", { count: totalCount })}
        </span>
      </div>

      {/* Quick commit box */}
      {stagedCount > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <Input
            value={commitDraft}
            onChange={(e) => rootDir && setCommitDraft(rootDir, e.target.value)}
            placeholder={t("commitPlaceholder")}
            aria-label={t("commitLabel")}
            className="h-7 flex-1 text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void handleCommit()
              }
            }}
          />
          <Button
            variant="default"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={!commitDraft.trim() || isCommitting}
            onClick={() => void handleCommit()}
          >
            {t("commit")}
          </Button>
        </div>
      )}

      {/* Change list */}
      <ScrollArea className="flex-1">
        {totalCount === 0 ? (
          <Empty className="h-32 rounded-none">
            <EmptyTitle className="text-sm">{t("clean")}</EmptyTitle>
            <EmptyDescription className="text-xs">{t("cleanDescription")}</EmptyDescription>
          </Empty>
        ) : (
          <div className="divide-y">
            {stagedCount > 0 && (
              <div>
                <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                  {t("staged", { count: stagedCount })}
                </div>
                {status.staged.map((change) => (
                  <CompactChangeRow
                    key={`staged:${change.path}`}
                    change={change}
                    onUnstage={() => void actions.unstage([change.path])}
                  />
                ))}
              </div>
            )}
            {changedCount > 0 && (
              <div>
                <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                  {t("unstaged", { count: changedCount })}
                </div>
                {status.changes.map((change) => (
                  <CompactChangeRow
                    key={`unstaged:${change.path}`}
                    change={change}
                    onStage={() => void actions.stage([change.path])}
                    onDiscard={() => void actions.discard([change.path])}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {/* Footer link to full source control page */}
      <div className="shrink-0 border-t p-2">
        <Button variant="ghost" size="sm" className="w-full text-xs" asChild>
          <Link href="/source-control">
            <ExternalLinkIcon className="mr-1.5 size-3" />
            {t("openFullPage")}
          </Link>
        </Button>
      </div>
    </div>
  )
}

/** Compact change row for the workbench panel — status + filename + inline actions. */
function CompactChangeRow({
  change,
  onStage,
  onUnstage,
  onDiscard,
}: {
  change: GitFileChange
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
}) {
  const { dir, name } = splitPath(change.path)
  const { letter, colorClass } = statusDecoration(change.status)

  return (
    <div
      className="group flex items-center gap-1.5 px-3 py-1 hover:bg-accent/50"
      data-testid={`change-row-${change.path}`}
    >
      <span className={cn("w-4 shrink-0 text-center text-xs font-mono", colorClass)}>{letter}</span>
      <span className="min-w-0 flex-1 truncate text-xs">
        <span className="text-foreground">{name}</span>
        {dir && <span className="ml-1 text-muted-foreground">{dir}</span>}
      </span>
      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {onStage && (
          <Button variant="ghost" size="icon" className="size-5" onClick={onStage}>
            <CheckIcon className="size-3" />
          </Button>
        )}
        {onUnstage && (
          <Button variant="ghost" size="icon" className="size-5" onClick={onUnstage}>
            <MinusIcon className="size-3" />
          </Button>
        )}
        {onDiscard && (
          <Button variant="ghost" size="icon" className="size-5" onClick={onDiscard}>
            <Undo2Icon className="size-3" />
          </Button>
        )}
      </div>
    </div>
  )
}
