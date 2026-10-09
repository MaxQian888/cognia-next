"use client"

/**
 * "Edited 2 files +67 −1" under a finished turn: the files that turn changed,
 * with Undo and View changes.
 *
 * The data is the turn's own record (`useTurnChanges`), not the working tree,
 * so an earlier turn keeps its card after later turns, commits or manual edits,
 * and the card never lists a change the user made by hand.
 *
 * - **View changes** opens the dock review on this turn's diff (its Task
 *   Workspace patch). A turn the host only fingerprinted has counts and no
 *   patch; its review opens on the working tree, focused on the file.
 * - **Undo** reverts exactly this turn's patch through the Task Workspace
 *   ledger, which merges against later edits and reports a conflict rather
 *   than overwriting them. It is offered only when that patch is applied and
 *   kept its inverse; any other turn has no honest undo, so it shows none.
 */

import { useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { FileDiffIcon, Undo2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
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
import { splitPath } from "@/components/source-control/status-decoration"
import { useTurnChanges } from "@/hooks/chat/use-turn-changes"
import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import { getSession } from "@/lib/db/sessions"
import { getTaskPatchSet, undoTaskWorkspace } from "@/lib/task-workspace/client"
import type { PatchSet } from "@/lib/task-workspace/types"
import { cn } from "@/lib/utils"
import { sessionExecutionRootPath } from "@/lib/workspace/session-root"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { ReviewScopeChoice } from "@/types/review"

/** Files listed before "Show all". */
export const TURN_CHANGES_PREVIEW = 6

export interface TurnChangesCardProps {
  sessionId: string
  messageId: string
}

/** The Task Workspace run whose patch is this turn's diff, when there is one. */
export function turnPatchRunId(row: CodeAdoptionTurnRow): string | null {
  return row.measurement === "taskWorkspace" && row.taskWorkspaceRunId
    ? row.taskWorkspaceRunId
    : null
}

type PatchRead = { runId: string; patch: PatchSet | null }

export function TurnChangesCard({ sessionId, messageId }: TurnChangesCardProps) {
  const row = useTurnChanges(sessionId, messageId, true)
  if (!row || row.totalFiles === 0 || row.trackingState === "unavailable") return null
  return <TurnChangesCardBody sessionId={sessionId} row={row} />
}

function TurnChangesCardBody({ sessionId, row }: { sessionId: string; row: CodeAdoptionTurnRow }) {
  const t = useTranslations("chat.turnChanges")
  const [showAll, setShowAll] = useState(false)
  const [confirmUndo, setConfirmUndo] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [patchRead, setPatchRead] = useState<PatchRead | null>(null)
  const [patchEpoch, setPatchEpoch] = useState(0)
  const projects = useProjectStore((state) => state.projects)
  const session = useLiveQuery(() => getSession(sessionId), [sessionId])
  const rootPath = sessionExecutionRootPath(session, projects) ?? row.workspaceRoot
  const runId = turnPatchRunId(row)

  // The patch's state decides Undo. Re-read after an undo and whenever the
  // record's adoption state moves (an apply / undo from the task panel).
  useEffect(() => {
    if (!runId) return
    let cancelled = false
    getTaskPatchSet(runId)
      .then((patch) => {
        if (!cancelled) setPatchRead({ runId, patch })
      })
      .catch(() => {
        if (!cancelled) setPatchRead({ runId, patch: null })
      })
    return () => {
      cancelled = true
    }
  }, [runId, row.adoptionState, patchEpoch])

  const patch = patchRead && patchRead.runId === runId ? patchRead.patch : null
  const reverted = patch?.state === "reverted" || row.adoptionState === "reverted"
  const canUndo = Boolean(runId && patch?.state === "applied" && patch.reversible && !reverted)

  const files = useMemo(
    () => (showAll ? row.files : row.files.slice(0, TURN_CHANGES_PREVIEW)),
    [row.files, showAll]
  )
  const hidden = row.files.length - files.length

  const view = (relPath?: string) => {
    const scope: ReviewScopeChoice = runId ? { scope: "lastTurn", runId } : { scope: "uncommitted" }
    useArtifactDockLayoutStore.getState().revealWorkspaceReview({
      sessionId,
      rootPath,
      scope,
      ...(relPath ? { relPath } : {}),
    })
  }

  const runUndo = async () => {
    if (!runId) return
    setConfirmUndo(false)
    setUndoing(true)
    try {
      const outcome = await undoTaskWorkspace(runId)
      if (outcome.state === "reverted") {
        toast.success(t("undoSuccess", { count: row.totalFiles }))
      } else if (outcome.state === "conflict") {
        toast.error(t("undoConflict", { count: outcome.conflicts.length }))
      } else {
        toast.error(t("undoNotApplied"))
      }
    } catch (error) {
      toast.error(
        t("undoFailed", { error: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setUndoing(false)
      setPatchEpoch((value) => value + 1)
    }
  }

  return (
    <div
      className="not-prose mt-2 w-full overflow-hidden rounded-xl border bg-muted/20"
      data-testid="turn-changes-card"
      data-reverted={reverted}
    >
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted"
          aria-hidden
        >
          <FileDiffIcon className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium" data-testid="turn-changes-title">
            {reverted
              ? t("reverted", { count: row.totalFiles })
              : t("edited", { count: row.totalFiles })}
          </p>
          <p className="font-mono text-xs" data-testid="turn-changes-total">
            <span className="text-emerald-600 dark:text-emerald-400">+{row.totalAdded}</span>{" "}
            <span className="text-red-600 dark:text-red-400">−{row.totalRemoved}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canUndo ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1 text-xs"
              disabled={undoing}
              onClick={() => setConfirmUndo(true)}
              data-testid="turn-changes-undo"
            >
              {t("undo")}
              <Undo2Icon className="size-3.5" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => view()}
            data-testid="turn-changes-view"
          >
            {t("view")}
          </Button>
        </div>
      </div>

      <ul className="border-t py-1" data-testid="turn-changes-files">
        {files.map((file) => {
          const { dir, name } = splitPath(file.path)
          return (
            <li key={file.path}>
              <button
                type="button"
                className="flex min-h-9 w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-muted/60 md:min-h-0 md:py-1.5"
                onClick={() => view(file.path)}
                title={file.path}
                data-testid={`turn-changes-file-${file.path}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {dir ? <span className="text-muted-foreground">{dir}/</span> : null}
                  <span className="text-foreground">{name}</span>
                </span>
                <span className="shrink-0 font-mono text-[11px]">
                  <span className="text-emerald-600 dark:text-emerald-400">+{file.added}</span>{" "}
                  <span className="text-red-600 dark:text-red-400">−{file.removed}</span>
                </span>
              </button>
            </li>
          )
        })}
        {hidden > 0 ? (
          <li>
            <button
              type="button"
              className={cn(
                "w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setShowAll(true)}
              data-testid="turn-changes-show-all"
            >
              {t("showAll", { count: hidden })}
            </button>
          </li>
        ) : null}
        {row.truncated ? (
          <li
            className="px-3 py-1 text-[11px] text-muted-foreground"
            data-testid="turn-changes-truncated"
          >
            {t("truncated")}
          </li>
        ) : null}
      </ul>

      <AlertDialog open={confirmUndo} onOpenChange={setConfirmUndo}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("undoConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("undoConfirmDescription", { count: row.totalFiles })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="turn-changes-undo-confirm"
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
