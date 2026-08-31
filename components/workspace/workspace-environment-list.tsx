"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArchiveIcon,
  GitBranchPlusIcon,
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
import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"
import { openPathAsWorkspace } from "@/lib/workspace/open-folder"
import { runWorkspaceUserAction } from "@/lib/task-workspace/user-action"
import { useWorkspaceCommandGate } from "@/hooks/workspace/use-workspace-command-gate"
import { useElementWidth } from "@/hooks/use-element-width"
import { NewWorktreeForm } from "./new-worktree-form"
import { useWorkspaceActionController } from "@/hooks/use-workspace-action-controller"

export interface WorkspaceEnvironmentListProps {
  presentation?: "page" | "sheet"
  rootDir?: string
  /**
   * Scope the inventory to one Workspace. Rows this project does not own are
   * counted and reachable behind a toggle rather than hidden: a worktree on
   * disk that no project claims is exactly what the user needs to see in order
   * to reclaim it.
   */
  projectId?: string
  refreshKey?: number
  showPrune?: boolean
  /**
   * Offer worktree creation inline.
   *
   * Opt-in because the three mount points want different things: the
   * source-control sheet already renders the form above this list, and the
   * device runtime section is a read-out of another machine. `/workspace`
   * listed every environment and could make none, which is the gap this
   * closes.
   */
  showCreate?: boolean
  canMutate?: (command: string) => boolean
}

/**
 * Container width below which the table becomes a card list.
 *
 * A measured container width, not a viewport breakpoint and not a CSS
 * container query. This list is mounted in the `/workspace` tab, a
 * source-control sheet and the device runtime section, so the viewport never
 * describes the space it has (the reasoning `SettingsMasterDetail` writes
 * down). A CSS query would have to render both layouts and hide one, which
 * puts every action button in the accessibility tree twice.
 *
 * 640px is where the five columns stop fitting without the action column
 * sliding off the end, which is not a cosmetic problem: it made every control
 * on the row unreachable on a phone.
 */
const COMPACT_WIDTH = 640

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
  projectId,
  refreshKey = 0,
  showPrune = false,
  showCreate = false,
  canMutate = () => true,
}: WorkspaceEnvironmentListProps) {
  const t = useTranslations("workspace.environments")
  const [rows, setRows] = useState<WorkspaceEnvironmentSummary[] | null>(null)
  const [showAllProjects, setShowAllProjects] = useState(false)
  // Scoping happens here rather than in the query: the host answers with every
  // environment it knows about, and the count of the ones this Workspace does
  // not own is itself information — a worktree no project claims is what the
  // user needs to see in order to reclaim it.
  const scoped =
    rows === null || !projectId || showAllProjects
      ? rows
      : rows.filter((row) => row.projectId === projectId)
  // Counted independently of the toggle, so the way back is always offered.
  const otherProjectCount =
    rows === null || !projectId ? 0 : rows.filter((row) => row.projectId !== projectId).length
  const { pendingKey: pendingId, error, setError, clearError, run } = useWorkspaceActionController()
  // Per command, not per host. A device can hold `workspace.write` and still
  // lack the `host.admin` an interactive command needs, so `remove`, `prune`
  // and `delete` can each be available while the others are not.
  const gate = useWorkspaceCommandGate()
  const containerRef = useRef<HTMLElement | null>(null)
  const containerWidth = useElementWidth(containerRef)
  // Zero means "not measured yet". The table is the unmeasured default so a
  // wide pane never flashes cards on first paint.
  const compact = containerWidth > 0 && containerWidth < COMPACT_WIDTH
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEnvironmentSummary | null>(null)
  const [branchTarget, setBranchTarget] = useState<WorkspaceEnvironmentSummary | null>(null)
  const [branchName, setBranchName] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
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

  /**
   * Every managed action is `approval: "interactive"`, so from a paired phone
   * or browser it needs an admin lease. These used to be bare `transport.call`
   * and answered `interactive_approval_required` remotely while the list they
   * sat in rendered fine, because the reads need no approval.
   *
   * The command name is a parameter rather than derived, because the lease is
   * bound to one exact command and a wrong name mints a lease the host will
   * reject.
   */
  const runManagedAction = async (
    row: WorkspaceEnvironmentSummary,
    command: string,
    operation: (workspaceId: string) => Promise<unknown>
  ) => {
    const workspaceId = row.workspaceId
    if (!workspaceId) return
    await run(row.environmentId, async () => {
      await runWorkspaceUserAction(command, () => operation(workspaceId))
      await load()
    })
  }

  const confirmDelete = async () => {
    if (!deleteTarget?.workspaceId) return
    const target = deleteTarget
    setDeleteTarget(null)
    await runManagedAction(target, "task_workspace_managed_delete", deleteManagedWorkspace)
  }

  const confirmCreateBranch = async () => {
    const target = branchTarget
    const branch = branchName.trim()
    if (!target?.workspaceId || !branch || !hasAction(target, "createBranchHere")) return
    const created = await run(target.environmentId, () =>
      runWorkspaceUserAction("task_workspace_environment_create_branch", () =>
        createWorkspaceBranch(target.workspaceId!, branch)
      )
    )
    if (!created) return
    setBranchTarget(null)
    setBranchName("")
    await load()
  }

  const adoptEnvironment = async (row: WorkspaceEnvironmentSummary) => {
    if (row.workspaceId) {
      await runManagedAction(row, "task_workspace_managed_adopt", adoptManagedWorkspace)
      return
    }
    await run(row.environmentId, async () => {
      await runWorkspaceUserAction("task_workspace_environment_adopt", () =>
        adoptWorkspaceEnvironment(row.environmentId, row.sourceRoot, row.path)
      )
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

  /**
   * Disabled-with-a-reason props for one action button.
   *
   * `canMutate` is the caller's own veto (the source-control sheet passes the
   * git panel's policy) and the gate is the host's. Both must say yes, and
   * whichever says no supplies the tooltip, so a disabled button is never
   * silent about why.
   */
  const actionProps = (command: string, key?: string) => {
    const verdict = gate(command)
    const allowed = verdict.available && canMutate(command)
    return {
      // `key` is the row this action belongs to. Creation has no row, so it
      // passes none and is not disabled by another row's pending action.
      disabled: (key !== undefined && pendingId === key) || !allowed,
      title: verdict.reason ?? undefined,
      "data-unavailable": allowed ? undefined : "true",
    }
  }

  // ---------------------------------------------------------------- row parts
  //
  // The table and the card list are two containers over ONE row. Rendering the
  // cells twice is how a control ends up on the wide layout and not the narrow
  // one, so the parts are built here and both containers place them.

  const renderIdentity = (row: WorkspaceEnvironmentSummary) => (
    <>
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
    </>
  )

  const renderKind = (row: WorkspaceEnvironmentSummary) => (
    <>
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
    </>
  )

  const renderActions = (row: WorkspaceEnvironmentSummary) => (
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
          {...actionProps("task_workspace_managed_pin", row.environmentId)}
          onClick={() =>
            void runManagedAction(row, "task_workspace_managed_pin", (workspaceId) =>
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
          {...actionProps("task_workspace_managed_permanent", row.environmentId)}
          onClick={() =>
            void runManagedAction(
              row,
              "task_workspace_managed_permanent",
              makeManagedWorkspacePermanent
            )
          }
          aria-label={t("makePermanent")}
        >
          <ShieldCheckIcon aria-hidden className="size-4" />
        </Button>
      ) : null}
      {hasAction(row, "createBranchHere") && row.workspaceId ? (
        <Button
          size="icon-sm"
          variant="ghost"
          {...actionProps("task_workspace_environment_create_branch", row.environmentId)}
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
          {...actionProps("task_workspace_managed_archive", row.environmentId)}
          onClick={() =>
            void runManagedAction(row, "task_workspace_managed_archive", archiveManagedWorkspace)
          }
          aria-label={t("archive")}
        >
          <ArchiveIcon aria-hidden className="size-4" />
        </Button>
      ) : null}
      {hasAction(row, "adopt") ? (
        <Button
          size="icon-sm"
          variant="ghost"
          {...actionProps(
            row.workspaceId ? "task_workspace_managed_adopt" : "task_workspace_environment_adopt",
            row.environmentId
          )}
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
          {...actionProps("task_workspace_managed_restore", row.environmentId)}
          onClick={() =>
            void runManagedAction(row, "task_workspace_managed_restore", restoreManagedWorkspace)
          }
          aria-label={t("restore")}
        >
          <RotateCcwIcon aria-hidden className="size-4" />
        </Button>
      ) : null}
      {hasAction(row, "delete") && row.workspaceId ? (
        <Button
          size="icon-sm"
          variant="ghost"
          {...actionProps("task_workspace_managed_delete", row.environmentId)}
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
          {...actionProps("git_worktree_remove", row.environmentId)}
          onClick={() => requestRemove(row)}
          aria-label={t("remove")}
        >
          <Trash2Icon aria-hidden className="size-4" />
        </Button>
      ) : null}
    </div>
  )

  const canOpenPaths = !rootDir || !isRemoteGitTarget(rootDir)
  const canPrune = Boolean(rows?.some((row) => hasAction(row, "prune")))

  return (
    <section
      ref={containerRef}
      className="flex min-h-0 flex-col gap-2"
      data-testid="workspace-environments"
      data-density={compact ? "compact" : "full"}
      data-presentation={presentation}
    >
      {/* At card width the heading and its two actions do not fit on one row,
          and squeezing them wrapped the title to three lines beside the
          buttons. Wrapping the row instead puts the actions underneath. */}
      <div className={cn("flex items-center gap-2", compact && "flex-wrap")}>
        {presentation === "page" ? (
          <div className={cn("min-w-0 flex-1", compact && "basis-full")}>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("title")}
            </h2>
            <p className="text-xs text-muted-foreground">{t("description")}</p>
          </div>
        ) : (
          <span
            className={cn("min-w-0 flex-1 text-xs text-muted-foreground", compact && "basis-full")}
          >
            {t("count", { count: scoped?.length ?? 0 })}
          </span>
        )}
        {showCreate && rootDir ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setCreateOpen((current) => !current)}
            aria-expanded={createOpen}
            data-testid="workspace-environments-create-toggle"
            {...actionProps("git_worktree_add")}
          >
            <GitBranchPlusIcon aria-hidden className="size-4" />
            {t("create")}
          </Button>
        ) : null}
        {showPrune ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void prune()}
            {...(() => {
              const props = actionProps("git_worktree_prune")
              return { ...props, disabled: props.disabled || !canPrune || pendingId !== null }
            })()}
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

      {showCreate && rootDir && createOpen ? (
        <Surface radius="panel" className="border p-3" data-testid="workspace-environments-create">
          <NewWorktreeForm
            rootDir={rootDir}
            canMutate={canMutate}
            onCreated={() => {
              setCreateOpen(false)
              void load()
            }}
          />
        </Surface>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {t("loadError", { error })}
        </p>
      ) : null}

      {scoped === null ? (
        <div className="flex flex-col gap-2" aria-label={t("loading")}>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : scoped.length === 0 ? (
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
        <>
          {compact ? null : (
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
                {scoped.map((row) => (
                  <TableRow
                    key={row.environmentId}
                    data-testid={`workspace-environment-${row.environmentId}`}
                  >
                    <TableCell className="max-w-80">{renderIdentity(row)}</TableCell>
                    <TableCell>{renderKind(row)}</TableCell>
                    {presentation === "page" ? (
                      <TableCell>{row.state ? t(`states.${row.state}`) : t("stateNone")}</TableCell>
                    ) : null}
                    {presentation === "page" ? (
                      <TableCell className="font-mono text-xs">
                        {row.base ? t(`bases.${row.base.kind}`) : (row.branch ?? t("baseNone"))}
                      </TableCell>
                    ) : null}
                    <TableCell>{renderActions(row)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {/* Narrow container: one card per row, same parts. */}
          {compact ? (
            <ul className="flex flex-col gap-2">
              {scoped.map((row) => (
                <Surface asChild key={row.environmentId} radius="panel">
                  <li
                    data-testid={`workspace-environment-card-${row.environmentId}`}
                    className="flex flex-col gap-2 border p-3"
                  >
                    <div className="min-w-0">{renderIdentity(row)}</div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {renderKind(row)}
                      {presentation === "page" ? (
                        <span className="text-xs text-muted-foreground">
                          {row.state ? t(`states.${row.state}`) : t("stateNone")}
                        </span>
                      ) : null}
                      {presentation === "page" ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {row.base ? t(`bases.${row.base.kind}`) : (row.branch ?? t("baseNone"))}
                        </span>
                      ) : null}
                    </div>
                    {renderActions(row)}
                  </li>
                </Surface>
              ))}
            </ul>
          ) : null}
        </>
      )}

      {otherProjectCount > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          className="self-start text-xs text-muted-foreground"
          onClick={() => setShowAllProjects((current) => !current)}
          data-testid="workspace-environments-scope-toggle"
        >
          {showAllProjects
            ? t("scopeToWorkspace")
            : t("otherWorkspaces", { count: otherProjectCount })}
        </Button>
      ) : null}

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
