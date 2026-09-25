"use client"

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  AnchorIcon,
  ArchiveIcon,
  GitBranchPlusIcon,
  BoxesIcon,
  FolderMinusIcon,
  FolderOpenIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldCheckIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useFormatter, useNow, useTranslations } from "next-intl"

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
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
import { ConsoleSection } from "@/components/surface/console-section"
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
 * 560px rather than the 640 it was: collapsing the nine per-row icon buttons
 * into one overflow menu took roughly 200px off the action column, so the
 * table now fits comfortably well below the old threshold and a tablet-width
 * pane no longer drops to cards it does not need.
 */
const COMPACT_WIDTH = 560

/**
 * Row count above which the filter field is offered.
 *
 * A search box over two rows is furniture, not a control. Fixed rather than
 * derived from the container so the field does not appear and disappear as the
 * pane is resized, which is the jumpiest thing a toolbar can do.
 */
const SEARCH_THRESHOLD = 6

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

/** The band filter's value space: every band, plus "do not filter". */
type BandFilter = EnvironmentBand | "all"

export function bandOf(row: WorkspaceEnvironmentSummary): EnvironmentBand {
  // Locked, conflicted or prunable: something is wrong, or something can be
  // reclaimed. Either way the row is asking for a decision.
  if (row.locked || row.prunable || row.state === "conflict") return "attention"
  // Archived and restorable rows still exist on disk but nothing runs in them.
  if (row.state === "archived" || row.state === "restorable") return "dormant"
  if (row.state === "removing" || row.state === "removed") return "dormant"
  return "active"
}

/**
 * The one-glance state of a row.
 *
 * The bands already sort the list, but a band heading scrolls away and a row
 * read halfway down a long list carries none of it. Every comparable tool
 * (Warp's agent tabs, Cursor's worktree list, GitKraken's cards) leads the row
 * with a coloured dot for exactly this reason.
 *
 * Derived from `bandOf` rather than beside it, so the dot cannot ever disagree
 * with the group the row was filed under. `conflict` is split back out because
 * it is the one attention state that is a FAILURE rather than an offer, and
 * amber for "you could reclaim this" beside amber for "this is broken" is the
 * distinction the band alone throws away.
 */
export type EnvironmentPulse = "conflict" | "attention" | "active" | "provisioning" | "dormant"

export function pulseOf(row: WorkspaceEnvironmentSummary): EnvironmentPulse {
  if (row.state === "conflict") return "conflict"
  if (row.state === "provisioning") return "provisioning"
  const band = bandOf(row)
  if (band === "attention") return "attention"
  if (band === "dormant") return "dormant"
  return "active"
}

const PULSE_CLASS: Record<EnvironmentPulse, string> = {
  conflict: "bg-destructive",
  attention: "bg-amber-500",
  // Only the one that is genuinely mid-flight animates. A pulsing dot on every
  // healthy row is a screen full of movement that means nothing.
  provisioning: "animate-pulse bg-sky-500",
  active: "bg-emerald-500",
  dormant: "bg-muted-foreground/40",
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

/**
 * Everything a filter query is allowed to match.
 *
 * The path alone is not enough: the reader looking for "the worktree the
 * scheduler made" or "whatever is on feature/login" knows the branch or the
 * owner, not the generated directory name.
 */
function searchHaystack(row: WorkspaceEnvironmentSummary): string {
  return [row.path, row.branch ?? "", row.head ?? "", row.ownerRef ?? "", row.sourceRoot]
    .join("\n")
    .toLowerCase()
}

/** One entry in a row's overflow menu. */
interface RowAction {
  key: string
  label: string
  icon: LucideIcon
  /** Host command this maps to, for the availability gate. Omit if ungated. */
  command?: string
  destructive?: boolean
  onSelect: () => void
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
  const now = useNow({ updateInterval: 60_000 })
  const router = useRouter()
  const [rows, setRows] = useState<WorkspaceEnvironmentSummary[] | null>(null)
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [query, setQuery] = useState("")
  const [bandFilter, setBandFilter] = useState<BandFilter>("all")
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

  const trimmedQuery = query.trim().toLowerCase()
  /**
   * Text filter, applied before the band split.
   *
   * The band chips count what the query left behind rather than the whole
   * inventory: a chip reading "Active 12" over a filtered list of one is a
   * number about a list nobody is looking at.
   */
  const searched = useMemo(() => {
    if (scoped === null) return null
    if (!trimmedQuery) return scoped
    return scoped.filter((row) => searchHaystack(row).includes(trimmedQuery))
  }, [scoped, trimmedQuery])

  // Bands are derived, not stored, so a row that stops being prunable moves out
  // of the attention band on the next load without anybody writing a flag.
  const allBands = useMemo(() => {
    if (searched === null) return null
    const byBand = new Map<EnvironmentBand, WorkspaceEnvironmentSummary[]>()
    for (const row of searched) {
      const band = bandOf(row)
      const bucket = byBand.get(band)
      if (bucket) bucket.push(row)
      else byBand.set(band, [row])
    }
    return BAND_ORDER.map((band) => ({ band, rows: byBand.get(band) ?? [] })).filter(
      (group) => group.rows.length > 0
    )
  }, [searched])

  /**
   * What the list actually renders.
   *
   * The chip filter narrows the SAME derivation rather than a second one, so a
   * chip can never offer a band the list cannot then show. A chip whose band
   * has disappeared under the text query falls back to "all" during render
   * instead of leaving the reader on an empty selection they did not make.
   */
  const bandExists = allBands?.some((group) => group.band === bandFilter) ?? false
  const effectiveBand: BandFilter = bandFilter === "all" || bandExists ? bandFilter : "all"
  const bands = useMemo(
    () =>
      allBands === null || effectiveBand === "all"
        ? allBands
        : allBands.filter((group) => group.band === effectiveBand),
    [allBands, effectiveBand]
  )
  const visibleCount = (bands ?? []).reduce((total, group) => total + group.rows.length, 0)

  const { pendingKey: pendingId, error, setError, clearError, run } = useWorkspaceActionController()
  // Per command, not per host. A device can hold `workspace.write` and still
  // lack the `host.admin` an interactive command needs, so `remove`, `prune`
  // and `delete` can each be available while the others are not.
  const gate = useWorkspaceCommandGate()
  const containerRef = useRef<HTMLDivElement | null>(null)
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
  const [reloading, setReloading] = useState(false)

  const load = useCallback(async () => {
    clearError()
    setReloading(true)
    try {
      const environments = await listWorkspaceEnvironments(rootDir)
      setRows(environments)
      return environments
    } catch (cause) {
      setError(errorDetail(cause))
      setRows([])
      return null
    } finally {
      setReloading(false)
    }
  }, [clearError, rootDir, setError])
  /**
   * The refresh buttons spin and refuse while any read is out, the first one
   * included. Clickable during a load, they stacked parallel reads whose
   * answers landed in whatever order the host returned them.
   */
  const refreshBusy = reloading || rows === null

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
    const pulse = pulseOf(row)
    return (
      <>
        <div className="flex min-w-0 items-center gap-1.5">
          {/*
            Named, not merely coloured. A dot that only exists as a hue is
            unreadable to a screen reader and to a third of colour-blind users,
            and this list is where someone decides what to delete.
          */}
          <span
            role="img"
            aria-label={t(`pulses.${pulse}`)}
            title={t(`pulses.${pulse}`)}
            data-testid={`workspace-environment-pulse-${row.environmentId}`}
            data-pulse={pulse}
            className={cn("size-2 shrink-0 rounded-full", PULSE_CLASS[pulse])}
          />
          <div className="min-w-0 flex-1 truncate font-mono text-xs" title={row.path}>
            {row.path}
          </div>
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
        {/*
          One dot-separated line that never wraps: the two short facts are
          `shrink-0` and the owner truncates. Wrapping was the bug — the break
          landed between a separator and its value, so the line ended in a bare
          "·" or the next one began with it, depending on which side gave way.

          In a card the owner gets its own line instead of truncating, because
          there it is the only fact with no length bound (a session title, a
          squad id) and a 340px column leaves it two or three characters.
        */}
        <div className="flex min-w-0 items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground">
          <span
            className="shrink-0"
            title={
              row.lastUsedAt
                ? format.dateTime(new Date(row.lastUsedAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : undefined
            }
          >
            {row.lastUsedAt ? format.relativeTime(new Date(row.lastUsedAt), now) : t("neverUsed")}
          </span>
          {row.sizeBytes !== undefined ? (
            <>
              <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-muted-foreground/50" />
              <span className="shrink-0 tabular-nums">{formatBytes(row.sizeBytes)}</span>
            </>
          ) : null}
          {owner && !compact ? (
            <>
              <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-muted-foreground/50" />
              <span className="min-w-0 truncate">{owner}</span>
            </>
          ) : null}
        </div>
        {owner && compact ? (
          <div className="min-w-0 truncate pt-0.5 text-[11px] text-muted-foreground">{owner}</div>
        ) : null}
        <div className="flex flex-wrap gap-1 pt-1 empty:hidden">
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

  /**
   * Everything this row offers beyond "open", in menu order.
   *
   * Built as data rather than as nine conditional buttons for two reasons. The
   * row used to render up to nine icon-only ghost buttons, of which two pairs
   * were the SAME glyph with different meanings — `Trash2` for both "delete the
   * archived environment" and "remove the worktree", `ShieldCheck` for both
   * "adopt" and "make permanent" — so the most destructive controls on the
   * surface were the two you could not tell apart. A labelled menu ends that by
   * construction. It also collapses the action column, which is what let the
   * table survive down to a much narrower pane.
   */
  const rowActions = (row: WorkspaceEnvironmentSummary): RowAction[] => {
    const actions: RowAction[] = []
    if (hasAction(row, "pin") && row.workspaceId) {
      actions.push({
        key: "pin",
        label: row.pinned ? t("unpin") : t("pin"),
        icon: row.pinned ? PinOffIcon : PinIcon,
        command: "task_workspace_managed_pin",
        onSelect: () =>
          void runManagedAction(row, "task_workspace_managed_pin", (workspaceId) =>
            pinManagedWorkspace(workspaceId, !row.pinned)
          ),
      })
    }
    if (hasAction(row, "createBranchHere") && row.workspaceId) {
      actions.push({
        key: "createBranch",
        label: t("createBranch"),
        icon: GitBranchPlusIcon,
        command: "task_workspace_environment_create_branch",
        onSelect: () => {
          setBranchTarget(row)
          setBranchName("")
        },
      })
    }
    if (hasAction(row, "makePermanent") && row.workspaceId) {
      actions.push({
        key: "makePermanent",
        label: t("makePermanent"),
        icon: AnchorIcon,
        command: "task_workspace_managed_permanent",
        onSelect: () =>
          void runManagedAction(
            row,
            "task_workspace_managed_permanent",
            makeManagedWorkspacePermanent
          ),
      })
    }
    if (hasAction(row, "adopt")) {
      actions.push({
        key: "adopt",
        label: t("adopt"),
        icon: ShieldCheckIcon,
        command: row.workspaceId
          ? "task_workspace_managed_adopt"
          : "task_workspace_environment_adopt",
        onSelect: () => void adoptEnvironment(row),
      })
    }
    if (hasAction(row, "restore") && row.workspaceId) {
      actions.push({
        key: "restore",
        label: t("restore"),
        icon: RotateCcwIcon,
        command: "task_workspace_managed_restore",
        onSelect: () =>
          void runManagedAction(row, "task_workspace_managed_restore", restoreManagedWorkspace),
      })
    }
    if (hasAction(row, "archive") && row.workspaceId) {
      actions.push({
        key: "archive",
        label: t("archive"),
        icon: ArchiveIcon,
        command: "task_workspace_managed_archive",
        destructive: true,
        onSelect: () =>
          void runManagedAction(row, "task_workspace_managed_archive", archiveManagedWorkspace),
      })
    }
    if (hasAction(row, "delete") && row.workspaceId) {
      actions.push({
        key: "delete",
        label: t("delete"),
        icon: Trash2Icon,
        command: "task_workspace_managed_delete",
        destructive: true,
        onSelect: () => setDeleteTarget(row),
      })
    }
    if (hasAction(row, "remove")) {
      actions.push({
        key: "remove",
        label: t("remove"),
        icon: FolderMinusIcon,
        command: "git_worktree_remove",
        destructive: true,
        onSelect: () => requestRemove(row),
      })
    }
    return actions
  }

  const renderActions = (row: WorkspaceEnvironmentSummary) => {
    const actions = rowActions(row)
    // The separator only earns its line when both halves exist.
    const firstDestructive = actions.findIndex((action) => action.destructive)
    return (
      <div className="flex shrink-0 items-center justify-end gap-0.5">
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
        {actions.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("rowActions")}
                data-testid={`workspace-environment-actions-${row.environmentId}`}
              >
                <MoreHorizontalIcon aria-hidden className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {actions.map((action, index) => (
                <Fragment key={action.key}>
                  {index === firstDestructive && index > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    variant={action.destructive ? "destructive" : "default"}
                    onClick={action.onSelect}
                    {...(action.command
                      ? actionProps(action.command, row.environmentId)
                      : { disabled: pendingId === row.environmentId })}
                  >
                    <action.icon aria-hidden className="size-4" />
                    {action.label}
                  </DropdownMenuItem>
                </Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    )
  }

  const canOpenPaths = !rootDir || !isRemoteGitTarget(rootDir)
  const canPrune = Boolean(rows?.some((row) => hasAction(row, "prune")))
  const offerSearch = (scoped?.length ?? 0) >= SEARCH_THRESHOLD || trimmedQuery.length > 0
  const offerBandFilter = (allBands?.length ?? 0) > 1
  const filtering = trimmedQuery.length > 0 || effectiveBand !== "all"
  /**
   * Whether the empty state is the one carrying the create offer.
   *
   * With nothing on disk there is exactly one thing to do, and printing the
   * same button twice — once greyed into a toolbar, once as the empty state's
   * call to action — makes the reader work out whether they differ. The toolbar
   * button comes back the moment the form is open, because then it is the
   * control that closes it again.
   */
  const emptyOffersCreate =
    Boolean(showCreate && rootDir) &&
    !createOpen &&
    !filtering &&
    searched !== null &&
    visibleCount === 0

  const clearFilters = () => {
    setQuery("")
    setBandFilter("all")
  }

  // ------------------------------------------------------------------ toolbar

  /**
   * One wrapping row: narrow-the-list controls first, change-the-list last.
   *
   * Wrapping rather than a fixed two-row split. The split reserved a whole row
   * for "New worktree" even on a 900px card, where it sat alone against the
   * right edge under an equally empty band; `flex-wrap` plus `ml-auto` gives
   * the same two rows at sheet width and one row when there is room. The order
   * still separates the two kinds, so a destructive Prune never lands beside a
   * filter chip.
   */
  const showCreateButton = Boolean(showCreate && rootDir) && !emptyOffersCreate
  const showActionRow = showCreateButton || showPrune || presentation === "sheet"

  const toolbar = (
    <div className="flex flex-col gap-2 empty:hidden" data-testid="workspace-environments-toolbar">
      {offerSearch || offerBandFilter || showActionRow ? (
        <div className="flex flex-wrap items-center gap-2">
          {offerSearch ? (
            <div className="relative min-w-40 flex-1">
              <SearchIcon
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("searchPlaceholder")}
                aria-label={t("searchPlaceholder")}
                className="h-8 pl-8 text-xs"
                data-testid="workspace-environments-search"
              />
              {query ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="absolute right-0.5 top-1/2 size-7 -translate-y-1/2"
                  onClick={() => setQuery("")}
                  aria-label={t("clearSearch")}
                >
                  <XIcon aria-hidden className="size-3.5" />
                </Button>
              ) : null}
            </div>
          ) : null}
          {offerBandFilter ? (
            <ToggleGroup
              type="single"
              value={effectiveBand}
              // Radix single groups emit "" when the active item is re-clicked.
              // Falling back to "all" keeps the control a true radio instead of
              // leaving the list filtered by nothing anybody selected.
              onValueChange={(next) => setBandFilter((next || "all") as BandFilter)}
              variant="outline"
              spacing={1.5}
              aria-label={t("bandFilterLabel")}
              className="flex flex-wrap"
              data-testid="workspace-environments-band-filter"
            >
              <ToggleGroupItem
                value="all"
                variant="outline"
                className="h-8 gap-1.5 rounded-control px-2.5 text-xs data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
              >
                {t("filterAll")}
                <span className="tabular-nums opacity-70">{searched?.length ?? 0}</span>
              </ToggleGroupItem>
              {(allBands ?? []).map((group) => (
                <ToggleGroupItem
                  key={group.band}
                  value={group.band}
                  variant="outline"
                  className="h-8 gap-1.5 rounded-control px-2.5 text-xs data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                  data-testid={`workspace-environments-filter-${group.band}`}
                >
                  <span
                    aria-hidden
                    className={cn("size-1.5 rounded-full", PULSE_CLASS[group.band])}
                  />
                  {t(`bands.${group.band}`)}
                  <span className="tabular-nums opacity-70">{group.rows.length}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}

          {/* The sheet has no masthead, so the count rides the toolbar there.
              It also does the job `flex-1` does for the search field on the
              page: pushing the mutation group to the far end. */}
          {presentation === "sheet" && !offerSearch ? (
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">
              {t("count", { count: scoped?.length ?? 0 })}
            </span>
          ) : null}

          {showActionRow ? (
            <div className="ml-auto flex items-center gap-2">
              {showCreateButton ? (
                <Button
                  size="sm"
                  variant={createOpen ? "secondary" : "outline"}
                  className="h-8"
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
                  className="h-8"
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
              {/* On the page the reload lives in the card masthead, beside the
                  count it refreshes. The sheet has no masthead of its own. */}
              {presentation === "sheet" ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => void load()}
                  disabled={refreshBusy}
                  aria-label={t("refresh")}
                >
                  <RefreshCwIcon
                    aria-hidden
                    className={cn("size-4", refreshBusy && "animate-spin")}
                  />
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )

  // ------------------------------------------------------------------- content

  const content =
    searched === null ? (
      // `role="status"`: an `aria-label` on a plain div names nothing a screen
      // reader announces, so the wait was silent.
      <div className="flex flex-col gap-2" role="status" aria-busy="true" aria-label={t("loading")}>
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    ) : visibleCount === 0 ? (
      /*
        Two different nothings. "This workspace has no environments" is answered
        with the way to make one; "your filter matched none" is answered with
        the way to clear it. One shared empty state told the reader to create a
        worktree when they had ten and had simply mistyped a branch name.
      */
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {filtering ? <SearchIcon aria-hidden /> : <BoxesIcon aria-hidden />}
          </EmptyMedia>
          <EmptyTitle>{filtering ? t("noMatchesTitle") : t("emptyTitle")}</EmptyTitle>
          <EmptyDescription>
            {filtering ? t("noMatchesDescription") : t("emptyDescription")}
          </EmptyDescription>
        </EmptyHeader>
        {filtering ? (
          <EmptyContent>
            <Button
              size="sm"
              variant="outline"
              onClick={clearFilters}
              data-testid="workspace-environments-clear-filters"
            >
              {t("clearFilters")}
            </Button>
          </EmptyContent>
        ) : showCreate && rootDir ? (
          <EmptyContent>
            <Button
              size="sm"
              onClick={() => setCreateOpen(true)}
              data-testid="workspace-environments-empty-create"
              {...actionProps("git_worktree_add")}
            >
              <GitBranchPlusIcon aria-hidden className="size-4" />
              {t("create")}
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    ) : compact ? (
      /* Narrow container: one card per row, same parts, same bands. */
      <div className="flex flex-col gap-3">
        {(bands ?? []).map((group) => (
          <section key={group.band} className="flex flex-col gap-2">
            <h3
              className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
              data-testid={`workspace-environment-band-${group.band}`}
            >
              <span aria-hidden className={cn("size-1.5 rounded-full", PULSE_CLASS[group.band])} />
              {t(`bands.${group.band}`)}
              <span className="font-normal tabular-nums">{group.rows.length}</span>
            </h3>
            <ul className="flex flex-col gap-2">
              {group.rows.map((row) => (
                <Surface asChild key={row.environmentId} radius="panel">
                  <li
                    data-testid={`workspace-environment-card-${row.environmentId}`}
                    className="flex flex-col gap-2 border p-3"
                  >
                    {/*
                      Actions ride beside the identity rather than under the
                      whole card. A `justify-end` footer row put the only
                      controls a card has at the far edge of a 340px column,
                      under two lines of metadata nobody was reading on the way
                      to them.
                    */}
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">{renderIdentity(row)}</div>
                      {renderActions(row)}
                    </div>
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
                  </li>
                </Surface>
              ))}
            </ul>
          </section>
        ))}
      </div>
    ) : (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("path")}</TableHead>
            <TableHead>{t("kind")}</TableHead>
            {presentation === "page" ? <TableHead>{t("state")}</TableHead> : null}
            {presentation === "page" ? <TableHead>{t("base")}</TableHead> : null}
            <TableHead className="w-20 text-right">{t("actions")}</TableHead>
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
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className={cn("size-1.5 rounded-full", PULSE_CLASS[group.band])}
                    />
                    {t(`bands.${group.band}`)}
                    <span className="font-normal tabular-nums">{group.rows.length}</span>
                  </span>
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
                    <TableCell>{row.state ? t(`states.${row.state}`) : t("stateNone")}</TableCell>
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
    )

  const body = (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-col gap-3"
      data-density={compact ? "compact" : "full"}
      data-presentation={presentation}
    >
      {toolbar}

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

      {content}

      {otherProjectCount > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 self-start text-xs text-muted-foreground"
          onClick={() => setShowAllProjects((current) => !current)}
          data-testid="workspace-environments-scope-toggle"
        >
          {showAllProjects
            ? t("scopeToWorkspace")
            : t("otherWorkspaces", { count: otherProjectCount })}
        </Button>
      ) : null}
    </div>
  )

  const dialogs = (
    <>
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
    </>
  )

  /*
    On the page this is a console card like every other section of the tab; in
    the sheet it is frameless because the Sheet already drew a header and a
    border around it. The frame used to be hand-rolled here — a bare `<section>`
    with an uppercase `<h2>` — which is why the `/workspace` Environments tab
    read as one unfinished block stacked on two finished cards.
  */
  if (presentation === "page") {
    return (
      <>
        <ConsoleSection
          id="environments"
          // `workspace-section-*`, the prefix its siblings on the tab already
          // use. Not `workspace-environments`: the tab panel around it owns
          // that test id, and two elements answering one query is how a later
          // test asserts against the wrapper it did not mean.
          idPrefix="workspace-section"
          pane="workspace-pane"
          icon={BoxesIcon}
          title={t("title")}
          description={t("description")}
          meta={
            <span className="flex items-center gap-1">
              <span className="tabular-nums">{scoped?.length ?? 0}</span>
              <Button
                size="icon-sm"
                variant="ghost"
                className="-my-1 size-6"
                onClick={() => void load()}
                disabled={refreshBusy}
                aria-label={t("refresh")}
              >
                <RefreshCwIcon
                  aria-hidden
                  className={cn("size-3.5", refreshBusy && "animate-spin")}
                />
              </Button>
            </span>
          }
        >
          {body}
        </ConsoleSection>
        {dialogs}
      </>
    )
  }

  return (
    <section
      className="flex min-h-0 flex-col gap-2"
      data-testid="workspace-environments"
      data-presentation={presentation}
    >
      {body}
      {dialogs}
    </section>
  )
}
