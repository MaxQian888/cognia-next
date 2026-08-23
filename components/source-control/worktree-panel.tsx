"use client"

/**
 * Worktree management Sheet. The backend worktree module was originally
 * consumed only by agent-team isolation; this view exposes the same seam for
 * user-managed parallel checkouts without duplicating Git process logic.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { FolderOpenIcon, GitBranchPlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
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
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { pickDirectory } from "@/lib/files/file-bridge"
import {
  gitWorktreeAdd,
  gitWorktreeList,
  gitWorktreePrune,
  gitWorktreeRemove,
  runGitUserAction,
} from "@/lib/git/commands"
import { isRemoteGitTarget } from "@/lib/git/target"
import { openPathAsWorkspace } from "@/lib/workspace/open-folder"
import { listManagedWorkspaces, reconcileManagedWorkspaces } from "@/lib/task-workspace/client"
import { asGitError, type GitWorktree } from "@/types/git"
import type { ManagedWorkspaceRecord, WorkspaceEnvironmentKind } from "@/lib/task-workspace/types"

interface WorktreePanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootDir: string
  canMutate?: (command: string) => boolean
}

type WorktreeSuccessKey = "worktrees.created" | "worktrees.pruned" | "worktrees.removed"

function errorDetail(err: unknown): string {
  const payload = asGitError(err)
  if (payload?.detail) return payload.detail
  if (payload?.kind) return payload.kind
  return err instanceof Error ? err.message : String(err)
}

function normalizeWorktreePath(path: string): string {
  return path.replace(/[\\/]+$/, "")
}

async function loadUnifiedInventory(rootDir: string): Promise<{
  worktrees: GitWorktree[]
  registryRows: ManagedWorkspaceRecord[]
  registryAvailable: boolean
}> {
  const [worktrees, registry] = await Promise.all([
    gitWorktreeList(rootDir),
    reconcileManagedWorkspaces()
      .then(() => listManagedWorkspaces())
      .then((registryRows) => ({ registryRows, registryAvailable: true }))
      .catch(() => ({ registryRows: [], registryAvailable: false })),
  ])
  return { worktrees, ...registry }
}

export function WorktreePanel({ open, onOpenChange, rootDir, canMutate }: WorktreePanelProps) {
  const t = useTranslations("sourceControl")
  const tRef = useRef(t)
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [registryOwners, setRegistryOwners] = useState<Map<string, WorkspaceEnvironmentKind>>(
    new Map()
  )
  const [registryAvailable, setRegistryAvailable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [branch, setBranch] = useState("")
  const [baseRef, setBaseRef] = useState("")
  const [path, setPath] = useState("")
  const [removeTarget, setRemoveTarget] = useState<GitWorktree | null>(null)
  const [forceRemove, setForceRemove] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const remote = isRemoteGitTarget(rootDir)
  const can = canMutate ?? (() => true)

  useEffect(() => {
    tRef.current = t
  }, [t])

  const reload = useCallback(async () => {
    const inventory = await loadUnifiedInventory(rootDir)
    setWorktrees(inventory.worktrees)
    setRegistryOwners(
      new Map(
        inventory.registryRows.map((row) => [
          normalizeWorktreePath(row.executionRoot),
          row.environmentKind,
        ])
      )
    )
    setRegistryAvailable(inventory.registryAvailable)
  }, [rootDir])

  useEffect(() => {
    if (!open) return
    let alive = true
    void loadUnifiedInventory(rootDir)
      .then((inventory) => {
        if (!alive) return
        setWorktrees(inventory.worktrees)
        setRegistryOwners(
          new Map(
            inventory.registryRows.map((row) => [
              normalizeWorktreePath(row.executionRoot),
              row.environmentKind,
            ])
          )
        )
        setRegistryAvailable(inventory.registryAvailable)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setLoading(false)
        toast.error(tRef.current("worktrees.error", { message: errorDetail(err) }))
      })
    return () => {
      alive = false
    }
  }, [open, rootDir])

  const runMutation = async (
    command: string,
    fn: () => Promise<void>,
    successKey: WorktreeSuccessKey
  ): Promise<boolean> => {
    setBusy(true)
    try {
      await runGitUserAction(command, fn)
      await reload()
      toast.success(t(successKey))
      return true
    } catch (err) {
      toast.error(t("worktrees.error", { message: errorDetail(err) }))
      return false
    } finally {
      setBusy(false)
    }
  }

  const chooseDirectory = async () => {
    try {
      const selected = await pickDirectory()
      if (selected) setPath(selected)
    } catch (err) {
      toast.error(t("worktrees.error", { message: errorDetail(err) }))
    }
  }

  const createWorktree = async () => {
    const nextBranch = branch.trim()
    const nextPath = path.trim()
    if (!nextBranch || !nextPath) return
    const created = await runMutation(
      "git_worktree_add",
      () =>
        gitWorktreeAdd(rootDir, nextPath, nextBranch, baseRef.trim() || undefined, {
          source: "worktree-panel",
          ownerType: "user",
        }),
      "worktrees.created"
    )
    if (created) {
      setBranch("")
      setBaseRef("")
      setPath("")
    }
  }

  const requestRemove = (worktree: GitWorktree) => {
    if (!registryAvailable || registryOwners.has(normalizeWorktreePath(worktree.path))) return
    setForceRemove(false)
    setDeleteBranch(false)
    setRemoveTarget(worktree)
  }

  const removeWorktree = async () => {
    if (!removeTarget || removeTarget.isMain) return
    const inventory = await reconcileManagedWorkspaces()
      .then(() => listManagedWorkspaces())
      .then((registryRows) => ({ registryRows, registryAvailable: true }))
      .catch(() => ({ registryRows: [], registryAvailable: false }))
    setRegistryAvailable(inventory.registryAvailable)
    setRegistryOwners(
      new Map(
        inventory.registryRows.map((row) => [
          normalizeWorktreePath(row.executionRoot),
          row.environmentKind,
        ])
      )
    )
    if (!inventory.registryAvailable) {
      toast.error(t("worktrees.registryUnavailable"))
      return
    }
    if (
      inventory.registryRows.some(
        (row) =>
          normalizeWorktreePath(row.executionRoot) === normalizeWorktreePath(removeTarget.path)
      )
    ) {
      toast.error(t("worktrees.registryProtected"))
      setRemoveTarget(null)
      return
    }
    const removed = await runMutation(
      "git_worktree_remove",
      () =>
        gitWorktreeRemove(
          rootDir,
          removeTarget.path,
          forceRemove,
          deleteBranch ? (removeTarget.branch ?? undefined) : undefined,
          { source: "worktree-panel", ownerType: "user", reason: "user" }
        ),
      "worktrees.removed"
    )
    if (removed) setRemoveTarget(null)
  }

  const pruneWorktrees = () =>
    runMutation("git_worktree_prune", () => gitWorktreePrune(rootDir), "worktrees.pruned")

  const ownershipLabel = (kind: WorkspaceEnvironmentKind) => {
    switch (kind) {
      case "managed":
        return t("worktrees.ownership.managed")
      case "permanent":
        return t("worktrees.ownership.permanent")
      case "imported":
        return t("worktrees.ownership.imported")
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="flex w-[30rem] flex-col" data-testid="worktree-panel">
          <SheetHeader>
            <SheetTitle>{t("worktrees.title")}</SheetTitle>
            <SheetDescription>{t("worktrees.description")}</SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-3 border-b p-4">
            <div className="grid gap-1.5">
              <Label htmlFor="worktree-branch">{t("worktrees.branchLabel")}</Label>
              <Input
                id="worktree-branch"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder={t("worktrees.branchPlaceholder")}
                data-testid="worktree-branch"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="worktree-base-ref">{t("worktrees.baseRefLabel")}</Label>
              <Input
                id="worktree-base-ref"
                value={baseRef}
                onChange={(event) => setBaseRef(event.target.value)}
                placeholder={t("worktrees.baseRefPlaceholder")}
                data-testid="worktree-base-ref"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="worktree-path">{t("worktrees.pathLabel")}</Label>
              <div className="flex gap-2">
                <Input
                  id="worktree-path"
                  value={path}
                  readOnly={!remote}
                  onChange={(event) => remote && setPath(event.target.value)}
                  placeholder={
                    remote ? t("worktrees.relativePathPlaceholder") : t("worktrees.pathPlaceholder")
                  }
                  className="min-w-0"
                  data-testid="worktree-path"
                />
                {!remote && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void chooseDirectory()}
                    disabled={busy}
                    data-testid="worktree-pick-directory"
                  >
                    <FolderOpenIcon className="size-3.5" />
                    {t("worktrees.chooseDirectory")}
                  </Button>
                )}
              </div>
            </div>
            <Button
              onClick={() => void createWorktree()}
              disabled={busy || !branch.trim() || !path.trim() || !can("git_worktree_add")}
              className="gap-1.5"
              data-testid="worktree-create"
            >
              {busy ? <Spinner className="size-3.5" /> : <GitBranchPlusIcon className="size-3.5" />}
              {t("worktrees.create")}
            </Button>
          </div>

          <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
            <span className="text-xs text-muted-foreground">
              {t("worktrees.count", { count: worktrees.length })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 text-xs"
              onClick={() => void pruneWorktrees()}
              disabled={busy || loading || !can("git_worktree_prune")}
              data-testid="worktree-prune"
            >
              <RefreshCwIcon className="size-3.5" />
              {t("worktrees.prune")}
            </Button>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            {loading && worktrees.length === 0 ? (
              <div className="flex justify-center p-8" data-testid="worktree-loading">
                <Spinner className="size-4" />
              </div>
            ) : (
              <ul className="flex flex-col gap-1 p-2">
                {worktrees.map((worktree) => {
                  const ownership = registryOwners.get(normalizeWorktreePath(worktree.path))
                  return (
                    <li
                      key={worktree.path}
                      className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent"
                      data-testid={`worktree-entry-${worktree.path}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                          <span className="truncate">
                            {worktree.branch ?? t("worktrees.detached")}
                          </span>
                          {worktree.isMain && (
                            <Badge variant="secondary" className="shrink-0 text-[10px]">
                              {t("worktrees.main")}
                            </Badge>
                          )}
                          {ownership && (
                            <Badge
                              variant="outline"
                              className="shrink-0 text-[10px]"
                              data-testid={`worktree-ownership-${worktree.path}`}
                            >
                              {ownershipLabel(ownership)}
                            </Badge>
                          )}
                        </div>
                        <div
                          className="truncate text-xs text-muted-foreground"
                          title={worktree.path}
                        >
                          {worktree.path}
                        </div>
                        {worktree.head && (
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {worktree.head.slice(0, 7)}
                          </div>
                        )}
                      </div>
                      {!remote && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => openPathAsWorkspace(worktree.path)}
                          data-testid={`worktree-open-${worktree.path}`}
                        >
                          {t("worktrees.open")}
                        </Button>
                      )}
                      {!worktree.isMain && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7 text-destructive"
                          aria-label={t("worktrees.remove")}
                          disabled={
                            !can("git_worktree_remove") || !registryAvailable || Boolean(ownership)
                          }
                          onClick={() => requestRemove(worktree)}
                          data-testid={`worktree-remove-${worktree.path}`}
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      )}
                    </li>
                  )
                })}
                {worktrees.length === 0 && (
                  <li className="px-2 py-6 text-center text-sm text-muted-foreground">
                    {t("worktrees.empty")}
                  </li>
                )}
              </ul>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(nextOpen) => !nextOpen && setRemoveTarget(null)}
      >
        <AlertDialogContent data-testid="worktree-remove-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("worktrees.removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("worktrees.removeDescription", { path: removeTarget?.path ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-3 py-2">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={forceRemove}
                onCheckedChange={(checked) => setForceRemove(Boolean(checked))}
                data-testid="worktree-remove-force"
              />
              <span>
                <span className="block font-medium">{t("worktrees.forceRemove")}</span>
                <span className="block text-xs text-muted-foreground">
                  {t("worktrees.forceRemoveDescription")}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={deleteBranch}
                disabled={!removeTarget?.branch}
                onCheckedChange={(checked) => setDeleteBranch(Boolean(checked))}
                data-testid="worktree-delete-branch"
              />
              <span>
                <span className="block font-medium">{t("worktrees.deleteBranch")}</span>
                <span className="block text-xs text-muted-foreground">
                  {t("worktrees.deleteBranchDescription", {
                    branch: removeTarget?.branch ?? t("worktrees.detached"),
                  })}
                </span>
              </span>
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void removeWorktree()
              }}
              data-testid="worktree-remove-confirm"
            >
              {t("worktrees.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
