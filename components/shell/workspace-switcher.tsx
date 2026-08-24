"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckIcon,
  ChevronDownIcon,
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
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { useProjectStore } from "@/stores/project/project-store"
import { primaryRootOf, allRootPaths } from "@/lib/workspace/roots"
import { isWorkspaceTrusted } from "@/lib/db/trusted-workspaces"
import { openFolderAsWorkspace } from "@/lib/workspace/open-folder"
import type { Project } from "@/types"
import { WorkspaceManageDialog } from "./workspace-manage-dialog"
import { NewWorkspaceDialog } from "@/components/workspace/new-workspace-dialog"
import { AdoptWorkspacesDialog } from "@/components/workspace/adopt-workspaces-dialog"
import { useAdoptionCandidates } from "@/hooks/workspace/use-adoption-candidates"

// Above this count the flat list stops being scannable, so we surface the
// search field and a "Recent" quick-access group. Below it the whole list fits
// in view and both would just be clutter.
const LARGE_THRESHOLD = 8
// How many most-recently-used workspaces to pin above the full list.
const RECENT_COUNT = 3

/**
 * Rail entry point for the active workspace. The trigger shows the active
 * workspace's initial (or a folder icon when none is active); the popover lists
 * every non-archived workspace for one-click switching and opens the manage
 * dialog for create / edit / delete. Switching drives `setActiveProject`, which
 * re-binds the Git panel + terminal scope and feeds the cwd chain.
 *
 * For large workspace sets the popover adds a live filter (name + folder path)
 * and a pinned "Recent" group so the list stays navigable at scale.
 */
interface WorkspaceSwitcherProps {
  /**
   * `rail` (default) — the 40px square initial in the icon column, tooltip
   * for the name, popover opening rightward. `wide` — a text trigger for the
   * title bar's start zone above the expanded sidebar: initial · name ·
   * chevron, popover opening downward under it. Same list, same actions.
   */
  variant?: "rail" | "wide"
  className?: string
}

export function WorkspaceSwitcher({ variant = "rail", className }: WorkspaceSwitcherProps = {}) {
  const t = useTranslations("workspace.switcher")
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const updateProject = useProjectStore((s) => s.updateProject)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [manageOpen, setManageOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [adoptOpen, setAdoptOpen] = useState(false)
  // Directories the app is already working in that no workspace owns. Collected
  // here rather than inside the dialog so the entry can carry the count — the
  // gap is invisible until something says how big it is.
  const { candidates: adoptable } = useAdoptionCandidates()
  // project id → has any untrusted root (desktop only).
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
  const active = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  )

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

  // Resolve per-workspace trust badges lazily (desktop only).
  useEffect(() => {
    if (!isTauri() || visible.length === 0) return
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

  const triggerLabel = active ? t("active", { name: active.name }) : t("none")
  const initial = active?.name.trim().charAt(0).toUpperCase()
  const wide = variant === "wide"

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) setQuery("")
  }
  const handleSwitch = (id: string) => {
    setActiveProject(id)
    handleOpenChange(false)
  }
  const openManage = () => {
    handleOpenChange(false)
    setManageOpen(true)
  }
  const handleOpenFolder = async () => {
    handleOpenChange(false)
    await openFolderAsWorkspace()
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
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
        >
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground",
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
          className="mr-1 flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <StarIcon className={cn("size-3.5", p.pinned && "fill-current text-amber-500")} />
        </button>
      </div>
    )
  }

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        {wide ? (
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={triggerLabel}
              data-testid="workspace-switcher"
              data-variant="wide"
              className={cn(
                "h-7 max-w-full min-w-0 gap-1.5 rounded-md px-1.5 text-foreground",
                className
              )}
            >
              <span
                aria-hidden
                className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/15 text-[11px] font-semibold text-primary"
              >
                {initial ?? <FolderIcon className="size-3.5" />}
              </span>
              <span className="truncate text-sm font-semibold tracking-tight">
                {active?.name ?? t("none")}
              </span>
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
        ) : (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={triggerLabel}
                  data-testid="workspace-switcher"
                  className={cn(
                    "size-10 rounded-2xl text-muted-foreground transition-all hover:rounded-xl hover:text-foreground",
                    className
                  )}
                >
                  {initial ? (
                    <span className="text-sm font-semibold">{initial}</span>
                  ) : (
                    <FolderIcon className="size-5" />
                  )}
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">{triggerLabel}</TooltipContent>
          </Tooltip>
        )}

        <PopoverContent side={wide ? "bottom" : "right"} align="start" className="w-72 p-1">
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t("heading")}
            </span>
            {visible.length > 0 && (
              <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground tabular-nums">
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

          <ScrollArea className="max-h-[min(20rem,50vh)]">
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
          {isTauri() && (
            <button
              type="button"
              onClick={() => void handleOpenFolder()}
              data-testid="workspace-switcher-open-folder"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
            >
              <FolderOpenIcon className="size-4 text-muted-foreground" />
              {t("openFolder")}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setCreateOpen(true)
            }}
            data-testid="workspace-switcher-new"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
          >
            <PlusIcon className="size-4 text-muted-foreground" />
            {t("newWorkspace")}
          </button>
          {/*
            Only when there is something to adopt: a permanent "Detected
            folders (0)" row would train the user to ignore the one time it
            matters. The count is the whole affordance.
          */}
          {adoptable.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setAdoptOpen(true)
              }}
              data-testid="workspace-switcher-adopt"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
            >
              <FolderSearchIcon className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left">{t("adoptEntry")}</span>
              <Badge variant="secondary" className="shrink-0 font-normal tabular-nums">
                {adoptable.length}
              </Badge>
            </button>
          )}
          <button
            type="button"
            onClick={openManage}
            data-testid="workspace-switcher-manage"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
          >
            <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
            {t("manage")}
          </button>
        </PopoverContent>
      </Popover>

      <NewWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
      <AdoptWorkspacesDialog open={adoptOpen} onOpenChange={setAdoptOpen} />
      <WorkspaceManageDialog open={manageOpen} onOpenChange={setManageOpen} />
    </>
  )
}

export default WorkspaceSwitcher
