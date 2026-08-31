"use client"

/**
 * The workspace list, and the dialogs its footer opens.
 *
 * Two shells need this: the desktop rail/title-bar `WorkspaceSwitcher` inside a
 * Popover, and the mobile header chip inside a Drawer. It lived in the switcher
 * and could not be reached from the second one without copying it, which is how
 * two lists start disagreeing about what "recent" means.
 *
 * Split deliberately in two parts:
 *
 *  - {@link WorkspacePickerList} is CONTENT ONLY. It renders rows and calls
 *    back, and owns no dialog.
 *  - {@link useWorkspacePickerDialogs} owns the dialogs and their open state,
 *    and returns an element the caller mounts OUTSIDE the Popover or Drawer.
 *
 * That split is not stylistic. A Drawer unmounts its children when it closes,
 * and every footer action here closes the container before opening a dialog.
 * If the list owned the dialogs, tapping "New workspace" would unmount the
 * thing it had just asked to open, and nothing would appear.
 */

import { useEffect, useMemo, useState, type ReactElement } from "react"
import { useTranslations } from "next-intl"
import {
  CheckIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderSearchIcon,
  PlusIcon,
  SearchIcon,
  ShieldAlertIcon,
  SlidersHorizontalIcon,
  StarIcon,
  XIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { useProjectStore } from "@/stores/project/project-store"
import { primaryRootOf, allRootPaths } from "@/lib/workspace/roots"
import { isWorkspaceTrusted } from "@/lib/db/trusted-workspaces"
import { openFolderAsWorkspace, openPathAsWorkspace } from "@/lib/workspace/open-folder"
import { useAdoptionCandidates } from "@/hooks/workspace/use-adoption-candidates"
import { useWorkspaceCommandGate } from "@/hooks/workspace/use-workspace-command-gate"
import { WorkspaceFolderPicker } from "@/components/shell/workspace-folder-picker"
import { WorkspaceManageDialog } from "@/components/shell/workspace-manage-dialog"
import { NewWorkspaceDialog } from "@/components/workspace/new-workspace-dialog"
import { AdoptWorkspacesDialog } from "@/components/workspace/adopt-workspaces-dialog"
import type { Project } from "@/types"

// Above this count the flat list stops being scannable, so the search field and
// a "Recent" quick-access group appear. Below it the whole list fits in view and
// both would just be clutter.
const LARGE_THRESHOLD = 8
// How many most-recently-used workspaces to pin above the full list.
const RECENT_COUNT = 3

/** What the footer can do, wired by {@link useWorkspacePickerDialogs}. */
export interface WorkspacePickerActions {
  openFolder: () => void
  newWorkspace: () => void
  adopt: () => void
  manage: () => void
  /** False on an unpaired browser: no native dialog and no host to walk. */
  canOpenFolder: boolean
  adoptableCount: number
}

export interface WorkspacePickerListProps {
  actions: WorkspacePickerActions
  /** Fired after the active workspace changes, so the container can close. */
  onSwitched?: () => void
  /** Touch targets are taller in a Drawer than in a Popover. */
  density?: "compact" | "comfortable"
  className?: string
}

/**
 * Everything the footer opens, owned above the Popover or Drawer.
 *
 * Also resolves the two facts the footer needs but the list should not compute
 * twice: whether a folder can be opened at all on this host, and how many
 * directories are sitting there unadopted.
 */
export function useWorkspacePickerDialogs(): {
  actions: WorkspacePickerActions
  element: ReactElement
} {
  const [manageOpen, setManageOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [adoptOpen, setAdoptOpen] = useState(false)
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  // Collected here rather than inside the dialog so the entry can carry the
  // count: the gap is invisible until something says how big it is.
  const { candidates: adoptable } = useAdoptionCandidates()
  const gate = useWorkspaceCommandGate()
  // The desktop has a native dialog. A paired phone or browser has no local
  // filesystem worth opening but CAN walk the host's, which is the machine the
  // agent will actually run on. Only an unpaired browser has neither.
  const canOpenFolder = isTauri() || gate("fs_list_workspace_dir").available

  const actions: WorkspacePickerActions = {
    openFolder: () => {
      if (isTauri()) {
        void openFolderAsWorkspace()
        return
      }
      setFolderPickerOpen(true)
    },
    newWorkspace: () => setCreateOpen(true),
    adopt: () => setAdoptOpen(true),
    manage: () => setManageOpen(true),
    canOpenFolder,
    adoptableCount: adoptable.length,
  }

  const element = (
    <>
      <WorkspaceFolderPicker
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onSelect={(path) => openPathAsWorkspace(path)}
      />
      <NewWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
      <AdoptWorkspacesDialog open={adoptOpen} onOpenChange={setAdoptOpen} />
      <WorkspaceManageDialog open={manageOpen} onOpenChange={setManageOpen} />
    </>
  )

  return { actions, element }
}

export function WorkspacePickerList({
  actions,
  onSwitched,
  density = "compact",
  className,
}: WorkspacePickerListProps) {
  const t = useTranslations("workspace.switcher")
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const updateProject = useProjectStore((s) => s.updateProject)

  const [query, setQuery] = useState("")
  // project id to "has any untrusted root".
  const [untrustedMap, setUntrustedMap] = useState<Record<string, boolean>>({})

  const visible = useMemo(
    () => projects.filter((p) => !p.isArchived).sort((a, b) => a.name.localeCompare(b.name)),
    [projects]
  )
  const recent = useMemo(
    () =>
      [...visible]
        .sort((a, b) => +new Date(b.lastAccessedAt) - +new Date(a.lastAccessedAt))
        .slice(0, RECENT_COUNT),
    [visible]
  )
  const pinned = useMemo(() => visible.filter((project) => project.pinned), [visible])

  const isLarge = visible.length >= LARGE_THRESHOLD
  const trimmed = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!trimmed) return visible
    return visible.filter(
      (p) =>
        p.name.toLowerCase().includes(trimmed) ||
        allRootPaths(p).some((path) => path.toLowerCase().includes(trimmed))
    )
  }, [visible, trimmed])
  // Pin the Recent group only when the list is large and unfiltered.
  const showRecent = isLarge && !trimmed && recent.length > 0
  const showPinned = !trimmed && pinned.length > 0

  // Resolve per-workspace trust badges lazily. `isWorkspaceTrusted` reads the
  // Dexie `trustedWorkspaces` table, so this works on every shell.
  useEffect(() => {
    if (visible.length === 0) return
    let cancelled = false
    void Promise.all(
      visible.map(async (p) => {
        const paths = allRootPaths(p)
        if (paths.length === 0) return [p.id, false] as const
        const verdicts = await Promise.all(paths.map((path) => isWorkspaceTrusted(path)))
        return [p.id, verdicts.some((v) => !v)] as const
      })
    ).then((entries) => {
      if (cancelled) return

      setUntrustedMap(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [visible])

  const roomy = density === "comfortable"
  const handleSwitch = (id: string) => {
    setActiveProject(id)
    setQuery("")
    onSwitched?.()
  }
  const runAction = (action: () => void) => {
    // Close the container FIRST. A Drawer unmounts its children, so a dialog
    // opened before the close would be torn down by it.
    onSwitched?.()
    action()
  }

  const renderRow = (p: Project, keyPrefix = "") => {
    const primaryPath = primaryRootOf(p)?.path
    const rootCount = p.roots?.length ?? 0
    const isActive = activeProjectId === p.id
    return (
      <div
        key={`${keyPrefix}${p.id}`}
        className={cn(
          "group flex w-full items-center rounded-md text-sm transition-colors hover:bg-accent",
          isActive && "bg-primary/10"
        )}
      >
        <button
          type="button"
          onClick={() => handleSwitch(p.id)}
          data-testid={`workspace-switch-${keyPrefix}${p.id}`}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 px-2 text-left",
            roomy ? "py-2.5" : "py-1.5"
          )}
        >
          <span
            className={cn(
              "flex shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground",
              roomy ? "size-8" : "size-7",
              isActive && "bg-primary/15 text-primary"
            )}
          >
            {isActive ? <FolderOpenIcon className="size-4" /> : <FolderIcon className="size-4" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1">
              <span className={cn("truncate", isActive && "font-medium")}>{p.name}</span>
              {untrustedMap[p.id] && (
                <ShieldAlertIcon
                  aria-label={t("untrustedHint")}
                  className="size-3 shrink-0 text-amber-500"
                />
              )}
            </span>
            {primaryPath && (
              <span className="block truncate font-mono text-[10px] text-muted-foreground">
                {primaryPath}
                {rootCount > 1 && (
                  <span className="ml-1">· {t("folderCount", { count: rootCount })}</span>
                )}
              </span>
            )}
          </span>
          {isActive && <CheckIcon className="size-4 shrink-0 text-primary" />}
        </button>
        <button
          type="button"
          aria-label={p.pinned ? t("unpin", { name: p.name }) : t("pin", { name: p.name })}
          data-testid={`workspace-pin-${keyPrefix}${p.id}`}
          onClick={() => updateProject(p.id, { pinned: !p.pinned })}
          className={cn(
            "mr-1 flex shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground",
            roomy ? "size-9" : "size-7"
          )}
        >
          <StarIcon className={cn("size-3.5", p.pinned && "fill-current text-amber-500")} />
        </button>
      </div>
    )
  }

  const footerButton = (
    key: string,
    icon: ReactElement,
    label: string,
    onClick: () => void,
    trailing?: ReactElement
  ) => (
    <button
      type="button"
      onClick={onClick}
      data-testid={key}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-accent",
        roomy ? "py-2.5" : "py-1.5"
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing}
    </button>
  )

  return (
    <div className={cn("flex min-h-0 flex-col", className)} data-testid="workspace-picker-list">
      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("heading")}
        </span>
        {visible.length > 0 && (
          <span className="rounded-pill bg-muted px-1.5 text-[10px] font-medium text-muted-foreground tabular-nums">
            {visible.length}
          </span>
        )}
      </div>

      {isLarge && (
        <div className="relative px-1 pb-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            data-testid="workspace-switcher-search"
            className="h-8 w-full rounded-md border border-input bg-transparent pr-8 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t("clearSearch")}
              data-testid="workspace-switcher-search-clear"
              className="absolute top-1/2 right-3 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>
      )}

      <ScrollArea className={cn("min-h-0", roomy ? "max-h-[60vh]" : "max-h-[min(20rem,50vh)]")}>
        <div className="flex flex-col">
          {visible.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">{t("empty")}</div>
          ) : trimmed && filtered.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              {t("noMatches")}
            </div>
          ) : (
            <>
              {showPinned && (
                <>
                  <div className="px-2 pt-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                    {t("pinnedHeading")}
                  </div>
                  {pinned.map((project) => renderRow(project, "pinned-"))}
                </>
              )}
              {showRecent && (
                <>
                  <div className="px-2 pt-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                    {t("recentHeading")}
                  </div>
                  {recent.map((p) => renderRow(p, "recent-"))}
                  <div className="mt-1 px-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                    {t("allHeading")}
                  </div>
                </>
              )}
              {(trimmed ? filtered : visible).map((p) => renderRow(p))}
            </>
          )}
        </div>
      </ScrollArea>

      <Separator className="my-1" />
      {actions.canOpenFolder &&
        footerButton(
          "workspace-switcher-open-folder",
          <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />,
          t("openFolder"),
          () => runAction(actions.openFolder)
        )}
      {footerButton(
        "workspace-switcher-new",
        <PlusIcon className="size-4 shrink-0 text-muted-foreground" />,
        t("newWorkspace"),
        () => runAction(actions.newWorkspace)
      )}
      {/*
        Only when there is something to adopt: a permanent "Detected folders
        (0)" row would train the user to ignore the one time it matters. The
        count is the whole affordance.
      */}
      {actions.adoptableCount > 0 &&
        footerButton(
          "workspace-switcher-adopt",
          <FolderSearchIcon className="size-4 shrink-0 text-muted-foreground" />,
          t("adoptEntry"),
          () => runAction(actions.adopt),
          <Badge variant="secondary" className="shrink-0 font-normal tabular-nums">
            {actions.adoptableCount}
          </Badge>
        )}
      {footerButton(
        "workspace-switcher-manage",
        <SlidersHorizontalIcon className="size-4 shrink-0 text-muted-foreground" />,
        t("manage"),
        () => runAction(actions.manage)
      )}
    </div>
  )
}
