"use client"

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
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
import { useFormatter, useTranslations } from "next-intl"

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
import { formatBytes } from "@/lib/agent/utils"
import { useSessionStore } from "@/stores/chat/session-store"
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

/**
 * Which band a row belongs to.
 *
 * The list used to be one flat run ordered by whatever the host returned, so a
 * conflicted worktree and a healthy one read the same until you got to the
 * fourth column. Every comparable tool sorts by "does a human need to do
 * something here" first (GitKraken's agent cards, Vibe Kanban's
 * Needs-Attention / Running / Idle accordion), and it is the one ordering a
 * directory list can derive without extra round trips.
 */
type EnvironmentBand = "attention" | "active" | "dormant"

const BAND_ORDER: readonly EnvironmentBand[] = ["attention", "active", "dormant"]

export function bandOf(row: WorkspaceEnvironmentSummary): EnvironmentBand {
  // Locked, conflicted or prunable: something is wrong, or something can be
  // reclaimed. Either way the row is asking for a decision.
  if (row.locked || row.prunable || row.state === "conflict") return "attention"
  // Archived and restorable rows still exist on disk but nothing runs in them.
  if (row.state === "archived" || row.state === "restorable") return "dormant"
  if (row.state === "removing" || row.state === "removed") return "dormant"
  return "active"
}

/** Short HEAD, the length every Git UI settled on. */
function shortHead(head: string | null): string | null {
  if (!head) return null
  const trimmed = head.trim()
  return trimmed.length > 7 ? trimmed.slice(0, 7) : trimmed
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
  projectId,
  refreshKey = 0,
  showPrune = false,
  showCreate = false,
  canMutate = () => true,
}: WorkspaceEnvironmentListProps) {
  const t = useTranslations("workspace.environments")
  // next-intl's formatter IS the shared relative-time implementation here.
  // `lib/scheduler/format-utils#formatRelativeTime` looks like the reusable one
  // but is forward-looking (it answers "Overdue" for anything in the past),
  // because it exists for next-run times.
  const format = useFormatter()
  const router = useRouter()
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
  // Bands are derived, not stored, so a row that stops being prunable moves out
  // of the attention band on the next load without anybody writing a flag.
  const bands = useMemo(() => {
    if (scoped === null) return null
    const byBand = new Map<EnvironmentBand, WorkspaceEnvironmentSummary[]>()
    for (const row of scoped) {
      const band = bandOf(row)
      const bucket = byBand.get(band)
      if (bucket) bucket.push(row)
      else byBand.set(band, [row])
    }
    return BAND_ORDER.map((band) => ({ band, rows: byBand.get(band) ?? [] })).filter(
      (group) => group.rows.length > 0
    )
  }, [scoped])

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

  /**
   * The owner as a place you can go, not just a string.
   *
   * A worktree exists because something asked for it, and until now the row
   * named that something and then left the reader to find it by hand. Only the
   * owners this app can actually navigate to become links; a `user` or
   * `imported` row has no destination and stays plain text rather than a
   * control that goes nowhere.
   */
  const renderOwner = (row: WorkspaceEnvironmentSummary) => {
    if (!row.ownerType) return null
    const label = t(`ownerTypes.${row.ownerType}`)
    const ref = row.ownerRef
    if (!ref) return <span>{label}</span>

    const linkClass = "underline decoration-dotted underline-offset-2 hover:text-foreground"
    if (row.ownerType === "team") {
      return (
        <Link
          href={`/squads?id=${encodeURIComponent(ref)}`}
          className={linkClass}
          title={t("openOwner", { owner: label })}
        >
          {label} · {ref}
        </Link>
      )
    }
    if (row.ownerType === "scheduled") {
      return (
        <Link href="/scheduler" className={linkClass} title={t("openOwner", { owner: label })}>
          {label} · {ref}
        </Link>
      )
    }
    if (row.ownerType === "session") {
      return (
        <button
          type="button"
          className={cn(linkClass, "text-left")}
          title={t("openOwner", { owner: label })}
          onClick={() => {
            // Follows the session only. The guild/workspace follow is
            // `focusSession`'s job and it needs a `ChatSession` record this
            // list does not hold; the inventory is already workspace-scoped,
            // so the common case lands correctly either way.
            useSessionStore.getState().setActiveSession(ref)
            router.push("/")
          }}
        >
          {label} · {ref}
        </button>
      )
    }
    return (
      <span>
        {label} · {ref}
      </span>
    )
  }

  const renderIdentity = (row: WorkspaceEnvironmentSummary) => {
    const head = shortHead(row.head)
    const owner = renderOwner(row)
    return (
      <>
        <div className="truncate font-mono text-xs" title={row.path}>
          {row.path}
        </div>
        {/*
          Branch and HEAD used to be invisible here: `branch` only appeared as a
          fallback in the Base column when there was no base, so a worktree with
          a branch was exactly the case that did not show one, and `head` was
          projected by the host and never rendered at all.
        */}
        {row.branch || head ? (
          <div className="flex min-w-0 items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground">
            {row.branch ? (
              <>
                <GitBranchIcon aria-hidden className="size-3 shrink-0" />
                <span className="truncate font-mono" title={row.branch}>
                  {row.branch}
                </span>
              </>
            ) : null}
            {row.branch && head ? (
              <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-muted-foreground/50" />
            ) : null}
            {head ? (
              <span className="shrink-0 font-mono" title={row.head ?? undefined}>
                {head}
              </span>
            ) : null}
          </div>
        ) : null}
        {/*
          Footprint. `sizeBytes` and `lastUsedAt` have been on the host's
          Registry row since it shipped and were dropped by the projection, so
          the one surface that lists worktrees could not answer "what is taking
          up the disk" or "is anything still using this".
        */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 pt-0.5 text-[11px] text-muted-foreground">
          <span title={row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString() : undefined}>
            {row.lastUsedAt ? format.relativeTime(new Date(row.lastUsedAt)) : t("neverUsed")}
          </span>
          {row.sizeBytes !== undefined ? (
            <>
              <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-muted-foreground/50" />
              <span className="tabular-nums">{formatBytes(row.sizeBytes)}</span>
            </>
          ) : null}
          {owner ? (
            <>
              <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-muted-foreground/50" />
              <span className="min-w-0 truncate">{owner}</span>
            </>
          ) : null}
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
  }

  const renderKind = (row: WorkspaceEnvironmentSummary) => (
    // The owner moved into the identity block, where it sits beside the other
    // provenance facts instead of hanging under an unrelated badge.
    <Badge variant={row.ownership === "managed" ? "secondary" : "outline"}>
      {t(`ownership.${row.ownership}`)}
    </Badge>
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
                {(bands ?? []).map((group) => (
                  <Fragment key={group.band}>
                    {/*
                      A spanning header row rather than one table per band, so
                      every band keeps the same column widths. Three narrow
                      tables stacked would make the same path column three
                      different widths down the page.
                    */}
                    <TableRow
                      className="hover:bg-transparent"
                      data-testid={`workspace-environment-band-${group.band}`}
                    >
                      <TableCell
                        colSpan={presentation === "page" ? 5 : 3}
                        className="bg-muted/40 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                      >
                        {t(`bands.${group.band}`)}
                        <span className="ml-1.5 font-normal tabular-nums">{group.rows.length}</span>
                      </TableCell>
                    </TableRow>
                    {group.rows.map((row) => (
                      <TableRow
                        key={row.environmentId}
                        data-testid={`workspace-environment-${row.environmentId}`}
                      >
                        <TableCell className="max-w-80">{renderIdentity(row)}</TableCell>
                        <TableCell>{renderKind(row)}</TableCell>
                        {presentation === "page" ? (
                          <TableCell>
                            {row.state ? t(`states.${row.state}`) : t("stateNone")}
                          </TableCell>
                        ) : null}
                        {presentation === "page" ? (
                          <TableCell className="font-mono text-xs">
                            {row.base ? t(`bases.${row.base.kind}`) : t("baseNone")}
                          </TableCell>
                        ) : null}
                        <TableCell>{renderActions(row)}</TableCell>
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}

          {/* Narrow container: one card per row, same parts, same bands. */}
          {compact ? (
            <div className="flex flex-col gap-3">
              {(bands ?? []).map((group) => (
                <section key={group.band} className="flex flex-col gap-2">
                  <h3
                    className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                    data-testid={`workspace-environment-band-${group.band}`}
                  >
                    {t(`bands.${group.band}`)}
                    <span className="ml-1.5 font-normal tabular-nums">{group.rows.length}</span>
                  </h3>
                  <ul className="flex flex-col gap-2">
                    {group.rows.map((row) => (
                      <Surface asChild key={row.environmentId} radius="panel">
                        <li
                          data-testid={`workspace-environment-card-${row.environmentId}`}
                          className="flex flex-col gap-2 border p-3"
                        >
                          <div className="min-w-0">{renderIdentity(row)}</div>
                          {/*
                            The card has no column headers, so an unlabelled
                            placeholder is noise rather than information: a bare
                            dash beside the ownership badge says nothing the
                            reader can decode. The table keeps its placeholders,
                            because there the header names the column.
                          */}
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            {renderKind(row)}
                            {presentation === "page" && row.state ? (
                              <span className="text-xs text-muted-foreground">
                                {t(`states.${row.state}`)}
                              </span>
                            ) : null}
                            {presentation === "page" && row.base ? (
                              <span className="font-mono text-xs text-muted-foreground">
                                {t(`bases.${row.base.kind}`)}
                              </span>
                            ) : null}
                          </div>
                          {renderActions(row)}
                        </li>
                      </Surface>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
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
