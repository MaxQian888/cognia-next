"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileCode2Icon,
  GitCompareArrowsIcon,
  RotateCcwIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { ChatSession } from "@cognia/agent-config-types"
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
import { collectWorkspaceChanges, undoWorkspaceChanges } from "@/lib/git/workspace-changes"
import { resolveSessionProjectRoot } from "@/lib/workspace/roots"
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
  const [statResult, setStatResult] = useState<StatResult | null>(null)
  const projects = useProjectStore((state) => state.projects)
  const gitRootDir = useGitStore((state) => state.rootDir)
  const repoState = useGitStore((state) => state.repoState)
  const status = useGitStore((state) => state.status)

  const rootPath = resolveSessionProjectRoot(session, projects).root?.path
  const files = useMemo(() => (status ? collectWorkspaceChanges(status) : []), [status])

  useEffect(() => {
    if (
      breakpoint !== "desktop" ||
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
  }, [breakpoint, files.length, gitRootDir, repoState?.isRepo, rootPath, status])

  if (
    breakpoint !== "desktop" ||
    !rootPath ||
    gitRootDir !== rootPath ||
    !repoState?.isRepo ||
    !status ||
    files.length === 0
  ) {
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

  return (
    <div
      className="mx-3 mb-1 overflow-hidden rounded-md border bg-muted/20"
      data-testid="workspace-changes-card"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/50"
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
          <div className="max-h-48 overflow-y-auto py-1">
            {files.map((file) => {
              const stat = statsByPath.get(file.path)
              return (
                <button
                  key={file.path}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/60"
                  data-testid={`workspace-change-${file.path}`}
                  onClick={() => revealFile(file.path)}
                >
                  <FileCode2Icon className="size-3.5 shrink-0 text-muted-foreground" />
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
              )
            })}
          </div>
          <div className="flex items-center justify-end gap-1 border-t px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs"
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
              className="h-7 gap-1 text-xs"
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
    </div>
  )
}
