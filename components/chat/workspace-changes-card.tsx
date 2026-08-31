"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  GitCompareArrowsIcon,
  RotateCcwIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { ChatSession } from "@cognia/agent-config-types"
import { FileTypeIcon } from "@/components/shared/file-type-icon"
import { Button } from "@/components/ui/button"
import { useBreakpoint } from "@/hooks/ui"
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
import { gitDiffStat } from "@/lib/git/commands"
import {
  collectWorkspaceChanges,
  discardWorkspaceFile,
  undoWorkspaceChanges,
  type WorkspaceChangedFile,
} from "@/lib/git/workspace-changes"
import { sessionExecutionRootPath } from "@/lib/workspace/session-root"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useGitStore } from "@/stores/git/git-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { GitFileDiffStat, GitStatus } from "@/types/git"

interface WorkspaceChangesCardProps {
  session: ChatSession
}

interface StatResult {
  status: GitStatus
  stats: GitFileDiffStat[] | null
}

export function WorkspaceChangesCard({ session }: WorkspaceChangesCardProps) {
  const t = useTranslations("artifacts.workspace.card")
  const breakpoint = useBreakpoint()
  const [expanded, setExpanded] = useState(false)
  const [confirmUndo, setConfirmUndo] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [pendingDiscard, setPendingDiscard] = useState<WorkspaceChangedFile | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [statResult, setStatResult] = useState<StatResult | null>(null)
  const projects = useProjectStore((state) => state.projects)
  const gitRootDir = useGitStore((state) => state.rootDir)
  const repoState = useGitStore((state) => state.repoState)
  const status = useGitStore((state) => state.status)

  // Follows the conversation's execution root — the card compares this against
  // the Git panel's bound repo, and a worktree-bound conversation must not be
  // told "no changes" because the card was looking at the source checkout.
  const rootPath = sessionExecutionRootPath(session, projects)
  const files = useMemo(() => (status ? collectWorkspaceChanges(status) : []), [status])

  useEffect(() => {
    if (
      !rootPath ||
      gitRootDir !== rootPath ||
      !repoState?.isRepo ||
      !status ||
      files.length === 0
    ) {
      return
    }
    let alive = true
    void gitDiffStat(rootPath)
      .then((stats) => {
        if (alive) setStatResult({ status, stats })
      })
      .catch(() => {
        if (alive) setStatResult({ status, stats: null })
      })
    return () => {
      alive = false
    }
  }, [files.length, gitRootDir, repoState?.isRepo, rootPath, status])

  if (!rootPath || gitRootDir !== rootPath || !repoState?.isRepo || !status || files.length === 0) {
    return null
  }

  const currentStats = statResult?.status === status ? statResult.stats : undefined
  const statsByPath = new Map((currentStats ?? []).map((stat) => [stat.path, stat]))
  const totals = currentStats
    ? currentStats.reduce(
        (sum, stat) => ({
          insertions: sum.insertions + stat.insertions,
          deletions: sum.deletions + stat.deletions,
        }),
        { insertions: 0, deletions: 0 }
      )
    : null

  const revealFile = (relPath: string) => {
    useArtifactDockLayoutStore.getState().revealWorkspaceFile({
      sessionId: session.id,
      rootPath,
      relPath,
    })
  }

  const revealReview = () => {
    useArtifactDockLayoutStore.getState().revealWorkspaceReview({
      sessionId: session.id,
      rootPath,
    })
  }

  const runUndo = async () => {
    setConfirmUndo(false)
    setUndoing(true)
    try {
      await undoWorkspaceChanges(rootPath, status)
      toast.success(t("undoSuccess"))
    } catch (error) {
      toast.error(t("undoFailed", { error: String(error) }))
    } finally {
      setUndoing(false)
    }
  }

  const runFileDiscard = async () => {
    if (!pendingDiscard) return
    const file = pendingDiscard
    setPendingDiscard(null)
    setDiscarding(true)
    try {
      await discardWorkspaceFile(rootPath, file)
      toast.success(t("discardFileSuccess", { path: file.path }))
    } catch (error) {
      toast.error(t("discardFileFailed", { path: file.path, error: String(error) }))
    } finally {
      setDiscarding(false)
    }
  }

  return (
    <div
      className="mb-1 overflow-hidden rounded-md border bg-muted/20"
      data-testid="workspace-changes-card"
      data-breakpoint={breakpoint}
    >
      <button
        type="button"
        className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/50 md:min-h-0"
        aria-expanded={expanded}
        data-testid="workspace-changes-toggle"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? (
          <ChevronDownIcon className="size-3.5 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 font-medium" data-testid="workspace-changes-count">
          {t("editedFiles", { count: files.length })}
        </span>
        {totals && (
          <span
            className="shrink-0 font-mono text-[11px] text-muted-foreground"
            data-testid="workspace-changes-total"
          >
            <span className="text-emerald-600 dark:text-emerald-400">+{totals.insertions}</span>{" "}
            <span className="text-red-600 dark:text-red-400">−{totals.deletions}</span>
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t" data-testid="workspace-changes-list">
          <div className="max-h-[36dvh] overflow-y-auto py-1 md:max-h-48">
            {files.map((file) => {
              const stat = statsByPath.get(file.path)
              return (
                <div
                  key={file.path}
                  className="group flex items-center gap-1 pr-1 hover:bg-muted/60"
                >
                  <button
                    type="button"
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs md:min-h-0 md:py-1.5"
                    data-testid={`workspace-change-${file.path}`}
                    onClick={() => revealFile(file.path)}
                  >
                    <FileTypeIcon path={file.path} />
                    <span className="min-w-0 flex-1 truncate" title={file.path}>
                      {file.path}
                    </span>
                    {stat && (
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          +{stat.insertions}
                        </span>{" "}
                        <span className="text-red-600 dark:text-red-400">−{stat.deletions}</span>
                      </span>
                    )}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    // `pointer-coarse` matters more than the hover reveal here:
                    // `opacity-0` hides the button but leaves it tappable, so on
                    // touch this was an invisible destructive control sitting
                    // beside every row. Coarse pointers get it outright.
                    className="size-7 shrink-0 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
                    aria-label={t("discardFile")}
                    title={t("discardFile")}
                    data-testid={`workspace-change-discard-${file.path}`}
                    disabled={discarding}
                    onClick={() => setPendingDiscard(file)}
                  >
                    <RotateCcwIcon className="size-3.5" />
                  </Button>
                </div>
              )
            })}
          </div>
          <div className="grid grid-cols-2 gap-2 border-t px-2 py-2 md:flex md:items-center md:justify-end md:gap-1 md:py-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-10 gap-1 text-xs md:h-7"
              data-testid="workspace-changes-undo"
              disabled={undoing}
              onClick={() => setConfirmUndo(true)}
            >
              <RotateCcwIcon className="size-3.5" />
              {t("undo")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="h-10 gap-1 text-xs md:h-7"
              data-testid="workspace-changes-review"
              onClick={revealReview}
            >
              <GitCompareArrowsIcon className="size-3.5" />
              {t("review")}
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirmUndo} onOpenChange={setConfirmUndo}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("undoConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("undoConfirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="workspace-changes-undo-confirm"
              onClick={() => void runUndo()}
            >
              {t("undoConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingDiscard !== null}
        onOpenChange={(open) => !open && setPendingDiscard(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("discardFileConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("discardFileConfirmDescription", { path: pendingDiscard?.path ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="workspace-change-discard-confirm"
              onClick={() => void runFileDiscard()}
            >
              {t("discardFileConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
