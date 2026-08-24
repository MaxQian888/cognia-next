"use client"

import { useCallback, useEffect, useState } from "react"
import {
  ArchiveIcon,
  BoxesIcon,
  FolderOpenIcon,
  GitBranchIcon,
  PinIcon,
  PinOffIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"
import { useTranslations } from "next-intl"

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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { gitWorktreePrune, gitWorktreeRemove, runGitUserAction } from "@/lib/git/commands"
import { isRemoteGitTarget } from "@/lib/git/target"
import {
  adoptManagedWorkspace,
  adoptWorkspaceEnvironment,
  archiveManagedWorkspace,
  createWorkspaceBranch,
  deleteManagedWorkspace,
  listWorkspaceEnvironments,
  makeManagedWorkspacePermanent,
  pinManagedWorkspace,
  restoreManagedWorkspace,
} from "@/lib/task-workspace/client"
import type {
  WorkspaceEnvironmentAction,
  WorkspaceEnvironmentSummary,
} from "@/lib/task-workspace/types"
import { openPathAsWorkspace } from "@/lib/workspace/open-folder"
import { useWorkspaceActionController } from "@/hooks/use-workspace-action-controller"

export interface WorkspaceEnvironmentListProps {
  presentation?: "page" | "sheet"
  rootDir?: string
  refreshKey?: number
  showPrune?: boolean
  canMutate?: (command: string) => boolean
}

function hasAction(row: WorkspaceEnvironmentSummary, action: WorkspaceEnvironmentAction) {
  return row.allowedActions.includes(action)
}

function errorDetail(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "detail" in cause) {
    const detail = (cause as { detail?: unknown }).detail
    if (typeof detail === "string") return detail
  }
  return String(cause)
}

/** Canonical Registry + Git environment inventory, reusable in page and sheet containers. */
export function WorkspaceEnvironmentList({
  presentation = "page",
  rootDir,
  refreshKey = 0,
  showPrune = false,
  canMutate = () => true,
}: WorkspaceEnvironmentListProps) {
  const t = useTranslations("workspace.environments")
  const [rows, setRows] = useState<WorkspaceEnvironmentSummary[] | null>(null)
  const { pendingKey: pendingId, error, setError, clearError, run } = useWorkspaceActionController()
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEnvironmentSummary | null>(null)
  const [branchTarget, setBranchTarget] = useState<WorkspaceEnvironmentSummary | null>(null)
  const [branchName, setBranchName] = useState("")
  const [removeTarget, setRemoveTarget] = useState<WorkspaceEnvironmentSummary | null>(null)
  const [forceRemove, setForceRemove] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(false)

  const load = useCallback(async () => {
    clearError()
    try {
      const environments = await listWorkspaceEnvironments(rootDir)
      setRows(environments)
      return environments
    } catch (cause) {
      setError(errorDetail(cause))
      setRows([])
      return null
    }
  }, [clearError, rootDir, setError])

  useEffect(() => {
    let cancelled = false
    void listWorkspaceEnvironments(rootDir).then(
      (environments) => {
        if (!cancelled) setRows(environments)
      },
      (cause: unknown) => {
        if (cancelled) return
        setError(errorDetail(cause))
        setRows([])
      }
    )
    return () => {
      cancelled = true
    }
  }, [rootDir, refreshKey, setError])

  const runManagedAction = async (
    row: WorkspaceEnvironmentSummary,
    operation: (workspaceId: string) => Promise<unknown>
  ) => {
    if (!row.workspaceId) return
    await run(row.environmentId, async () => {
      await operation(row.workspaceId)
      await load()
    })
  }

  const confirmDelete = async () => {
    if (!deleteTarget?.workspaceId) return
    const target = deleteTarget
    setDeleteTarget(null)
    await runManagedAction(target, deleteManagedWorkspace)
  }

  const confirmCreateBranch = async () => {
    const target = branchTarget
    const branch = branchName.trim()
    if (!target?.workspaceId || !branch || !hasAction(target, "createBranchHere")) return
    const created = await run(target.environmentId, () =>
      createWorkspaceBranch(target.workspaceId!, branch)
    )
    if (!created) return
    setBranchTarget(null)
    setBranchName("")
    await load()
  }

  const adoptEnvironment = async (row: WorkspaceEnvironmentSummary) => {
    if (row.workspaceId) {
      await runManagedAction(row, adoptManagedWorkspace)
      return
    }
    await run(row.environmentId, async () => {
      await adoptWorkspaceEnvironment(row.environmentId, row.sourceRoot, row.path)
      await load()
    })
  }

  const requestRemove = (row: WorkspaceEnvironmentSummary) => {
    if (!hasAction(row, "remove")) return
    setForceRemove(false)
    setDeleteBranch(false)
    setRemoveTarget(row)
  }

  const confirmRemove = async () => {
    if (!removeTarget) return
    const target = removeTarget
    await run(target.environmentId, async () => {
      const currentRows = await listWorkspaceEnvironments(rootDir)
      setRows(currentRows)
      const current = currentRows.find(
        (row) => row.environmentId === target.environmentId || row.path === target.path
      )
      if (!current || !hasAction(current, "remove")) {
        setRemoveTarget(null)
        throw new Error(t("registryProtected"))
      }
      await runGitUserAction("git_worktree_remove", () =>
        gitWorktreeRemove(
          rootDir ?? current.sourceRoot,
          current.path,
          forceRemove,
          deleteBranch ? (current.branch ?? undefined) : undefined,
          { source: "worktree-panel", ownerType: "user", reason: "user" }
        )
      )
      setRemoveTarget(null)
      await load()
    })
  }

  const prune = async () => {
    const target = rows?.find((row) => hasAction(row, "prune"))
    if (!target || !canMutate("git_worktree_prune")) return
    await run(target.environmentId, async () => {
      await runGitUserAction("git_worktree_prune", () =>
        gitWorktreePrune(rootDir ?? target.sourceRoot)
      )
      await load()
    })
  }

  const canOpenPaths = !rootDir || !isRemoteGitTarget(rootDir)
  const canPrune = Boolean(rows?.some((row) => hasAction(row, "prune")))

  return (
    <section
      className="flex min-h-0 flex-col gap-2"
      data-testid="workspace-environments"
      data-presentation={presentation}
    >
      <div className="flex items-center gap-2">
        {presentation === "page" ? (
          <div className="min-w-0 flex-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("title")}
            </h2>
            <p className="text-xs text-muted-foreground">{t("description")}</p>
          </div>
        ) : (
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {t("count", { count: rows?.length ?? 0 })}
          </span>
        )}
        {showPrune ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void prune()}
            disabled={!canPrune || !canMutate("git_worktree_prune") || pendingId !== null}
            aria-label={t("prune")}
          >
            <RefreshCwIcon aria-hidden className="size-4" />
            {t("prune")}
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => void load()}
          aria-label={t("refresh")}
        >
          <RefreshCwIcon aria-hidden className="size-4" />
        </Button>
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {t("loadError", { error })}
        </p>
      ) : null}

      {rows === null ? (
        <div className="flex flex-col gap-2" aria-label={t("loading")}>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BoxesIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("path")}</TableHead>
              <TableHead>{t("kind")}</TableHead>
              {presentation === "page" ? <TableHead>{t("state")}</TableHead> : null}
              {presentation === "page" ? <TableHead>{t("base")}</TableHead> : null}
              <TableHead className="text-right">{t("actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.environmentId}
                data-testid={`workspace-environment-${row.environmentId}`}
              >
                <TableCell className="max-w-80">
                  <div className="truncate font-mono text-xs" title={row.path}>
                    {row.path}
                  </div>
                  <div className="flex flex-wrap gap-1 pt-1">
                    {row.locked ? (
                      <Badge variant="outline" title={row.lockReason ?? undefined}>
                        {t("locked")}
                      </Badge>
                    ) : null}
                    {row.prunable ? (
                      <Badge variant="outline" title={row.pruneReason ?? undefined}>
                        {t("prunable")}
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col items-start gap-1">
                    <Badge variant={row.ownership === "managed" ? "secondary" : "outline"}>
                      {t(`ownership.${row.ownership}`)}
                    </Badge>
                    {row.ownerType ? (
                      <span className="text-xs text-muted-foreground">
                        {t(`ownerTypes.${row.ownerType}`)}
                        {row.ownerRef ? ` · ${row.ownerRef}` : null}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                {presentation === "page" ? (
                  <TableCell>{row.state ? t(`states.${row.state}`) : t("stateNone")}</TableCell>
                ) : null}
                {presentation === "page" ? (
                  <TableCell className="font-mono text-xs">
                    {row.base ? t(`bases.${row.base.kind}`) : (row.branch ?? t("baseNone"))}
                  </TableCell>
                ) : null}
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {hasAction(row, "open") && canOpenPaths ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => openPathAsWorkspace(row.path)}
                        aria-label={t("open")}
                      >
                        <FolderOpenIcon aria-hidden className="size-4" />
                      </Button>
                    ) : null}
                    {hasAction(row, "pin") && row.workspaceId ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={pendingId === row.environmentId}
                        onClick={() =>
                          void runManagedAction(row, (workspaceId) =>
                            pinManagedWorkspace(workspaceId, !row.pinned)
                          )
                        }
                        aria-label={row.pinned ? t("unpin") : t("pin")}
                      >
                        {row.pinned ? (
                          <PinOffIcon aria-hidden className="size-4" />
                        ) : (
                          <PinIcon aria-hidden className="size-4" />
                        )}
                      </Button>
                    ) : null}
                    {hasAction(row, "makePermanent") && row.workspaceId ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={pendingId === row.environmentId}
                        onClick={() => void runManagedAction(row, makeManagedWorkspacePermanent)}
                        aria-label={t("makePermanent")}
                      >
                        <ShieldCheckIcon aria-hidden className="size-4" />
                      </Button>
                    ) : null}
                    {hasAction(row, "createBranchHere") && row.workspaceId ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={pendingId === row.environmentId}
                        onClick={() => {
                          setBranchTarget(row)
                          setBranchName("")
                        }}
                        aria-label={t("createBranch")}
                      >
                        <GitBranchIcon aria-hidden className="size-4" />
                      </Button>
                    ) : null}
                    {hasAction(row, "archive") && row.workspaceId ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={pendingId === row.environmentId}
                        onClick={() => void runManagedAction(row, archiveManagedWorkspace)}
                        aria-label={t("archive")}
                      >
                        <ArchiveIcon aria-hidden className="size-4" />
                      </Button>
                    ) : null}
                    {hasAction(row, "adopt") ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={pendingId === row.environmentId}
                        onClick={() => void adoptEnvironment(row)}
                        aria-label={t("adopt")}
                      >
                        <ShieldCheckIcon aria-hidden className="size-4" />
                      </Button>
                    ) : null}
                    {hasAction(row, "restore") && row.workspaceId ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={pendingId === row.environmentId}
                        onClick={() => void runManagedAction(row, restoreManagedWorkspace)}
                        aria-label={t("restore")}
                      >
                        <RotateCcwIcon aria-hidden className="size-4" />
                      </Button>
                    ) : null}
                    {hasAction(row, "delete") && row.workspaceId ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={pendingId === row.environmentId}
                        onClick={() => setDeleteTarget(row)}
                        aria-label={t("delete")}
                      >
                        <Trash2Icon aria-hidden className="size-4" />
                      </Button>
                    ) : null}
                    {hasAction(row, "remove") ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={
                          pendingId === row.environmentId || !canMutate("git_worktree_remove")
                        }
                        onClick={() => requestRemove(row)}
                        aria-label={t("remove")}
                      >
                        <Trash2Icon aria-hidden className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AlertDialog
        open={branchTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setBranchTarget(null)
            setBranchName("")
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("createBranchTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("createBranchDescription", { path: branchTarget?.path ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
            placeholder={t("branchNamePlaceholder")}
            aria-label={t("branchName")}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!branchName.trim() || pendingId !== null}
              onClick={() => void confirmCreateBranch()}
            >
              {t("confirmCreateBranch")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription", { path: deleteTarget?.path ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {t("confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeDescription", { path: removeTarget?.path ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-3 py-2">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={forceRemove}
                onCheckedChange={(checked) => setForceRemove(Boolean(checked))}
              />
              <span>{t("forceRemove")}</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={deleteBranch}
                disabled={!removeTarget?.branch}
                onCheckedChange={(checked) => setDeleteBranch(Boolean(checked))}
              />
              <span>{t("deleteBranch")}</span>
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmRemove()}>
              {t("confirmRemove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
