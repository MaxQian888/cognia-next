"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  DownloadIcon,
  FolderInputIcon,
  FolderPlusIcon,
  GitBranchIcon,
  HistoryIcon,
  PinIcon,
  RotateCcwIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { gitStatus } from "@/lib/git/commands"
import {
  handoffSessionToLocal,
  handoffSessionToManaged,
  pinSessionWorktree,
  pruneSessionWorktree,
  resolveSessionHandoffConflict,
  restoreSessionSnapshot,
  undoSessionHandoff,
} from "@/lib/task-workspace/handoff"
import {
  getBundleHandoffUndoOutcome,
  getTaskPatchSet,
  getWorkspaceBundleTurn,
  listTaskRuns,
} from "@/lib/task-workspace/client"
import {
  convertManagedWorkspaceToProject,
  createManagedWorkspaceArchive,
  deleteManagedWorkspace,
  importManagedWorkspaceArchive,
  materializeManagedWorkspace,
  rebindManagedWorkspace,
  restoreManagedWorkspace,
  type ManagedWorkspaceArchive,
} from "@/lib/task-workspace/managed-workspace"
import { saveExport } from "@/lib/files/save-export"
import { isTauri } from "@/lib/platform/detect"
import type {
  BundleHandoffRootSelection,
  PatchSelection,
  PatchSet,
  TaskRun,
} from "@/lib/task-workspace/types"
import type { ChatSession } from "@cognia/agent-config-types"
import type { SessionExecutionContext } from "@/types/execution-context"
import { useWorkspaceActionController } from "@/hooks/use-workspace-action-controller"

interface DirtyPreview {
  isGitRepository: boolean
  paths: string[]
}

interface ConflictRow {
  path: string
  reason: string
}

interface BundleRootPatch {
  workspaceId: string
  logicalRootId: string
  runId: string
  patch: PatchSet
}

interface SessionExecutionWorkspaceProps {
  session: ChatSession
  projectId?: string
  projectRoot?: string
  rootId?: string
  environmentId?: string
}

export function SessionExecutionWorkspace(props: SessionExecutionWorkspaceProps) {
  const executionContext = props.session.executionContext
  const contextVersion = [
    props.session.id,
    executionContext?.location,
    executionContext?.taskWorkspace.runId,
    executionContext?.taskWorkspace.bundleTurnId,
    executionContext?.lifecycle?.updatedAt,
  ].join(":")
  return <SessionExecutionWorkspaceContent key={contextVersion} {...props} />
}

function SessionExecutionWorkspaceContent({
  session,
  projectId,
  projectRoot,
  rootId,
  environmentId,
}: SessionExecutionWorkspaceProps) {
  const t = useTranslations("worktreeWorkflow")
  const [context, setContext] = useState<SessionExecutionContext | undefined>(
    session.executionContext
  )
  const [dirtyPreview, setDirtyPreview] = useState<DirtyPreview | null>(null)
  const [patch, setPatch] = useState<PatchSet | null>(null)
  const [bundlePatches, setBundlePatches] = useState<BundleRootPatch[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [allowIrreversible, setAllowIrreversible] = useState(false)
  const [conflicts, setConflicts] = useState<ConflictRow[]>([])
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [bundleUndoRecovery, setBundleUndoRecovery] = useState<{
    bundleTurnId: string
    recovered: boolean
  } | null>(null)
  const { busy, error, run } = useWorkspaceActionController()
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const managedBinding = context?.workspaceBinding?.kind === "managed"
  const managedAvailability = context?.managedWorkspace?.availability ?? "missing-on-device"

  useEffect(() => {
    const taskId = context?.taskWorkspace.taskId
    if (!taskId) return
    let cancelled = false
    const bundleTurnId = context?.taskWorkspace.bundleTurnId
    const loadRuns = bundleTurnId
      ? getWorkspaceBundleTurn(bundleTurnId).then(
          (turn) => turn?.runs.map((lease) => lease.run) ?? []
        )
      : listTaskRuns(taskId)
    void loadRuns
      .then((rows) => {
        if (!cancelled) setRuns(rows.filter((row) => row.state === "ready"))
      })
      .catch(() => {
        if (!cancelled) setRuns([])
      })
    return () => {
      cancelled = true
    }
  }, [
    context?.taskWorkspace.taskId,
    context?.taskWorkspace.runId,
    context?.taskWorkspace.bundleTurnId,
  ])

  useEffect(() => {
    const bundleTurnId = context?.taskWorkspace.bundleTurnId
    if (!bundleTurnId) return
    let cancelled = false
    void getBundleHandoffUndoOutcome(bundleTurnId).then(
      (outcome) => {
        if (!cancelled) setBundleUndoRecovery({ bundleTurnId, recovered: outcome !== null })
      },
      () => {
        if (!cancelled) setBundleUndoRecovery({ bundleTurnId, recovered: false })
      }
    )
    return () => {
      cancelled = true
    }
  }, [context?.taskWorkspace.bundleTurnId])

  const bundleUndoRecovered = Boolean(
    context?.taskWorkspace.bundleTurnId &&
    bundleUndoRecovery?.bundleTurnId === context.taskWorkspace.bundleTurnId &&
    bundleUndoRecovery.recovered
  )

  const location = context?.location ?? "local"
  const selectedPatch = useMemo<PatchSelection[]>(
    () =>
      (patch?.files ?? [])
        .filter((file) => selectedPaths.has(file.path))
        .map((file) => ({ path: file.path, hunkIds: file.hunks.map((hunk) => hunk.id) })),
    [patch, selectedPaths]
  )
  const bundleSelections = useMemo<BundleHandoffRootSelection[]>(
    () =>
      bundlePatches.map((root) => ({
        workspaceId: root.workspaceId,
        logicalRootId: root.logicalRootId,
        selection: root.patch.files
          .filter((file) => selectedPaths.has(`${root.workspaceId}:${file.path}`))
          .map((file) => ({ path: file.path, hunkIds: file.hunks.map((hunk) => hunk.id) })),
      })),
    [bundlePatches, selectedPaths]
  )

  const runOperation = async (operation: () => Promise<void>) => {
    await run("session-environment", operation)
  }

  const previewLocalHandoff = () =>
    runOperation(async () => {
      if (!projectRoot) throw new Error(t("projectRootRequired"))
      try {
        const status = await gitStatus(projectRoot)
        const paths = [...status.staged, ...status.changes, ...status.merge].map(
          (change) => change.path
        )
        setDirtyPreview({ isGitRepository: true, paths: [...new Set(paths)] })
      } catch {
        setDirtyPreview({ isGitRepository: false, paths: [] })
      }
    })

  const confirmManagedHandoff = () =>
    runOperation(async () => {
      if (!dirtyPreview) return
      if (!projectId || !projectRoot) throw new Error(t("projectRootRequired"))
      const next = await handoffSessionToManaged({
        sessionId: session.id,
        projectId,
        projectRoot,
        rootId,
        environmentId,
        isGitRepository: dirtyPreview.isGitRepository,
        baseRef: context?.baseRef,
      })
      setContext(next)
      setDirtyPreview(null)
    })

  const materialize = () =>
    runOperation(async () => setContext(await materializeManagedWorkspace(session.id)))

  const rebind = () =>
    runOperation(async () => {
      if (!isTauri()) throw new Error(t("desktopRequired"))
      const { open } = await import("@tauri-apps/plugin-dialog")
      const selected = await open({ directory: true, multiple: false })
      if (typeof selected !== "string") return
      setContext(await rebindManagedWorkspace(session.id, selected))
    })

  const exportWorkspace = () =>
    runOperation(async () => {
      const archive = await createManagedWorkspaceArchive(session.id)
      const outcome = await saveExport({
        filename: `${archive.workspaceId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.cognia-workspace.json`,
        data: JSON.stringify(archive),
        mimeType: "application/json",
      })
      if (outcome.kind === "error") throw new Error(outcome.message)
    })

  const importWorkspace = (file: File) =>
    runOperation(async () => {
      const archive = JSON.parse(await file.text()) as ManagedWorkspaceArchive
      let target = context?.managedWorkspace?.localRoot
      if (!target)
        target = (await materializeManagedWorkspace(session.id)).managedWorkspace?.localRoot
      if (!target) throw new Error(t("desktopRequired"))
      setContext(await importManagedWorkspaceArchive(session.id, archive, target))
    })

  const convertToProject = () =>
    runOperation(async () => {
      const converted = await convertManagedWorkspaceToProject(session.id, session.title)
      setContext(converted.context)
    })

  const previewManagedHandoff = () =>
    runOperation(async () => {
      const bundleTurnId = context?.taskWorkspace.bundleTurnId
      if (bundleTurnId) {
        const turn = await getWorkspaceBundleTurn(bundleTurnId)
        if (!turn) throw new Error(t("bundleTurnMissing"))
        const roots = await Promise.all(
          turn.runs.map(async (lease) => {
            const next = await getTaskPatchSet(lease.run.runId)
            if (!next) return null
            return {
              workspaceId: lease.workspaceId,
              logicalRootId: lease.logicalRootIds.includes(turn.primaryLogicalRootId)
                ? turn.primaryLogicalRootId
                : lease.logicalRootIds[0],
              runId: lease.run.runId,
              patch: next,
            }
          })
        )
        const available = roots.filter((root): root is BundleRootPatch =>
          Boolean(root?.logicalRootId)
        )
        setBundlePatches(available)
        setSelectedPaths(
          new Set(
            available.flatMap((root) =>
              root.patch.files.map((file) => `${root.workspaceId}:${file.path}`)
            )
          )
        )
        setPatch(null)
        return
      }
      const runId = context?.taskWorkspace.runId
      if (!runId) throw new Error(t("runMissing"))
      const next = await getTaskPatchSet(runId)
      setPatch(next)
      setSelectedPaths(new Set(next?.files.map((file) => file.path) ?? []))
    })

  const confirmLocalHandoff = () =>
    runOperation(async () => {
      const outcome = await handoffSessionToLocal(
        session.id,
        selectedPatch,
        allowIrreversible,
        undefined,
        bundlePatches.length > 0 ? bundleSelections : undefined
      )
      setConflicts(outcome.conflicts)
      if (outcome.state !== "conflict" && context) {
        setContext({ ...context, location: "local" })
        setPatch(null)
        setBundlePatches([])
      }
    })

  const resolveConflict = (resolution: "retryMerge" | "applyTask" | "keepCurrent") =>
    runOperation(async () => {
      const outcome = await resolveSessionHandoffConflict(
        session.id,
        resolution,
        selectedPatch,
        allowIrreversible
      )
      setConflicts(outcome.conflicts)
    })

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3" data-testid="execution-workspace">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium">{t("title")}</p>
          <p className="text-[10px] text-muted-foreground">{t("description")}</p>
        </div>
        <Badge variant={location === "managedWorktree" ? "default" : "secondary"}>
          {location === "managedWorktree" ? t("managed") : t("local")}
        </Badge>
      </div>

      {context?.worktreePath && (
        <p className="break-all text-[10px] text-muted-foreground">
          {t("path", { path: context.worktreePath })}
        </p>
      )}
      {context?.branch && (
        <p className="text-[10px] text-muted-foreground">
          {t("branch", { branch: context.branch })}
        </p>
      )}
      {context?.lifecycle && (
        <p className="text-[10px] text-muted-foreground">
          {t("state", { state: context.lifecycle.state })}
        </p>
      )}

      {managedBinding && (
        <div className="space-y-2 rounded-md border p-2" data-testid="managed-workspace-assets">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-medium">{t("managedAssets.title")}</p>
              <p className="text-[11px] text-muted-foreground">
                {t(`managedAssets.availability.${managedAvailability}`)}
              </p>
            </div>
            <code className="max-w-full truncate text-[10px] text-muted-foreground">
              {context.workspaceBinding?.kind === "managed"
                ? context.workspaceBinding.workspaceId
                : ""}
            </code>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {managedAvailability === "missing-on-device" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void materialize()}
              >
                <FolderPlusIcon className="size-3.5" />
                {t("managedAssets.createHere")}
              </Button>
            )}
            {managedAvailability !== "deleted" && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void rebind()}>
                <FolderInputIcon className="size-3.5" />
                {t("managedAssets.rebind")}
              </Button>
            )}
            <Button asChild size="sm" variant="outline" disabled={busy}>
              <label>
                <UploadIcon className="size-3.5" />
                {t("managedAssets.import")}
                <input
                  className="sr-only"
                  type="file"
                  accept=".json,.cognia-workspace.json"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void importWorkspace(file)
                    event.target.value = ""
                  }}
                />
              </label>
            </Button>
            {managedAvailability === "available" && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void exportWorkspace()}
                >
                  <DownloadIcon className="size-3.5" />
                  {t("managedAssets.export")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void convertToProject()}
                >
                  <GitBranchIcon className="size-3.5" />
                  {t("managedAssets.convert")}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setDeleteConfirmOpen(true)}
                >
                  <Trash2Icon className="size-3.5" />
                  {t("managedAssets.delete")}
                </Button>
              </>
            )}
            {managedAvailability === "deleted" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void runOperation(async () =>
                    setContext(await restoreManagedWorkspace(session.id))
                  )
                }
              >
                <RotateCcwIcon className="size-3.5" />
                {t("managedAssets.restore")}
              </Button>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {t("managedAssets.sessionDeleteNote")}
          </p>
          <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("managedAssets.deleteTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("managedAssets.deleteDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setDeleteConfirmOpen(false)
                    void runOperation(async () =>
                      setContext(await deleteManagedWorkspace(session.id))
                    )
                  }}
                >
                  {t("managedAssets.deleteConfirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {error && (
        <p className="flex items-start gap-1 text-xs text-destructive" role="alert">
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
          {t("error", { message: error })}
        </p>
      )}

      {dirtyPreview && (
        <div className="space-y-2 rounded-md border p-2">
          <p className="text-xs font-medium">{t("dirtyTitle")}</p>
          {!dirtyPreview.isGitRepository ? (
            <p className="text-[11px] text-muted-foreground">{t("nonGit")}</p>
          ) : dirtyPreview.paths.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t("dirtyEmpty")}</p>
          ) : (
            <ul className="max-h-28 space-y-1 overflow-auto text-[11px]">
              {dirtyPreview.paths.map((path) => (
                <li key={path} className="break-all font-mono">
                  {path}
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDirtyPreview(null)}>
              {t("cancel")}
            </Button>
            <Button size="sm" onClick={() => void confirmManagedHandoff()} disabled={busy}>
              {t("continue")}
            </Button>
          </div>
        </div>
      )}

      {(patch || bundlePatches.length > 0) && (
        <div className="space-y-2 rounded-md border p-2">
          <p className="text-xs font-medium">{t("patchTitle")}</p>
          {(patch?.files.length ?? 0) === 0 &&
          bundlePatches.every((root) => root.patch.files.length === 0) ? (
            <p className="text-[11px] text-muted-foreground">{t("patchEmpty")}</p>
          ) : (
            (patch ? [{ workspaceId: "", logicalRootId: "", patch }] : bundlePatches).flatMap(
              (root) =>
                root.patch.files.map((file) => {
                  const selectionKey = root.workspaceId
                    ? `${root.workspaceId}:${file.path}`
                    : file.path
                  return (
                    <label
                      key={`${root.workspaceId}:${file.path}`}
                      className="flex items-start gap-2 text-[11px]"
                    >
                      <Checkbox
                        checked={selectedPaths.has(selectionKey)}
                        onCheckedChange={(checked) =>
                          setSelectedPaths((current) => {
                            const next = new Set(current)
                            if (checked) next.add(selectionKey)
                            else next.delete(selectionKey)
                            return next
                          })
                        }
                      />
                      <span className="break-all font-mono">
                        {root.logicalRootId ? `${root.logicalRootId}: ` : ""}
                        {file.path}
                      </span>
                    </label>
                  )
                })
            )
          )}
          {(patch ? !patch.reversible : bundlePatches.some((root) => !root.patch.reversible)) && (
            <label className="flex items-center gap-2 text-[11px]">
              <Checkbox
                checked={allowIrreversible}
                onCheckedChange={(value) => setAllowIrreversible(Boolean(value))}
              />
              {t("irreversible")}
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPatch(null)
                setBundlePatches([])
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              disabled={
                busy ||
                ((patch
                  ? !patch.reversible
                  : bundlePatches.some((root) => !root.patch.reversible)) &&
                  !allowIrreversible)
              }
              onClick={() => void confirmLocalHandoff()}
            >
              {t("confirmApply")}
            </Button>
          </div>
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
          <p className="text-xs font-medium">{t("conflictTitle")}</p>
          {conflicts.map((conflict) => (
            <p
              key={`${conflict.path}:${conflict.reason}`}
              className="text-[11px] text-muted-foreground"
            >
              {t("conflictReason", { path: conflict.path, reason: conflict.reason })}
            </p>
          ))}
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={() => void resolveConflict("retryMerge")}>
              {t("retryMerge")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void resolveConflict("applyTask")}>
              {t("applyTask")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void resolveConflict("keepCurrent")}>
              {t("keepCurrent")}
            </Button>
          </div>
        </div>
      )}

      {!dirtyPreview && !patch && bundlePatches.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          {location === "local" && projectId && projectRoot ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void previewLocalHandoff()}
            >
              <GitBranchIcon className="size-3.5" />
              {t("switchManaged")}
            </Button>
          ) : !managedBinding ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void previewManagedHandoff()}
            >
              {t("switchLocal")}
            </Button>
          ) : null}
          {context?.taskWorkspace.runId && !bundleUndoRecovered && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void runOperation(async () => {
                  await undoSessionHandoff(session.id)
                  setBundleUndoRecovery({ bundleTurnId, recovered: true })
                  if (context) setContext({ ...context, location: "managedWorktree" })
                })
              }
            >
              {t("undo")}
            </Button>
          )}
          {location === "managedWorktree" && context?.lifecycle && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void runOperation(async () => {
                  const pinned = !context.lifecycle?.pinned
                  await pinSessionWorktree(session.id, pinned)
                  setContext({
                    ...context,
                    lifecycle: { ...context.lifecycle!, pinned },
                  })
                })
              }
            >
              <PinIcon className="size-3.5" />
              {context.lifecycle.pinned ? t("unpin") : t("pin")}
            </Button>
          )}
          {location === "managedWorktree" && !managedBinding && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void runOperation(async () => void (await pruneSessionWorktree(session.id)))
              }
            >
              <Trash2Icon className="size-3.5" />
              {t("prune")}
            </Button>
          )}
        </div>
      )}

      {context && (
        <div className="space-y-1.5 border-t pt-2">
          <p className="flex items-center gap-1 text-xs font-medium">
            <HistoryIcon className="size-3.5" />
            {t("snapshots")}
          </p>
          {runs.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t("noSnapshots")}</p>
          ) : (
            runs.map((run) => (
              <Button
                key={run.runId}
                size="sm"
                variant="ghost"
                className="h-auto w-full justify-start px-2 py-1 text-left text-[11px]"
                disabled={busy || run.runId === context.taskWorkspace.runId}
                onClick={() =>
                  void runOperation(async () => {
                    const restored = await restoreSessionSnapshot(session.id, run.runId)
                    setContext({
                      ...context,
                      location: "managedWorktree",
                      worktreePath: restored.executionRoot,
                      branch: restored.isolationRef ?? undefined,
                      taskWorkspace: { ...context.taskWorkspace, runId: run.runId },
                    })
                  })
                }
              >
                {t("restore", { date: new Date(run.createdAt).toLocaleString() })}
              </Button>
            ))
          )}
        </div>
      )}
      {busy && <p className="text-[10px] text-muted-foreground">{t("busy")}</p>}
    </div>
  )
}
