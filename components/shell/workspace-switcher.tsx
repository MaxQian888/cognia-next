"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
  ShieldAlertIcon,
  SlidersHorizontalIcon,
} from "lucide-react"

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

/**
 * Rail entry point for the active workspace. The trigger shows the active
 * workspace's initial (or a folder icon when none is active); the popover lists
 * every non-archived workspace for one-click switching and opens the manage
 * dialog for create / edit / delete. Switching drives `setActiveProject`, which
 * re-binds the Git panel + terminal scope and feeds the cwd chain.
 */
export function WorkspaceSwitcher() {
  const t = useTranslations("workspace.switcher")
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)

  const [open, setOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [manageAutoCreate, setManageAutoCreate] = useState(false)
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
        .slice(0, 3),
    [visible]
  )
  const active = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  )

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

  const handleSwitch = (id: string) => {
    setActiveProject(id)
    setOpen(false)
  }
  const openManage = (autoCreate: boolean) => {
    setOpen(false)
    setManageAutoCreate(autoCreate)
    setManageOpen(true)
  }
  const handleOpenFolder = async () => {
    setOpen(false)
    await openFolderAsWorkspace()
  }

  const renderRow = (p: Project, keyPrefix = "") => {
    const primaryPath = primaryRootOf(p)?.path
    const rootCount = p.roots?.length ?? 0
    return (
      <button
        key={`${keyPrefix}${p.id}`}
        type="button"
        onClick={() => handleSwitch(p.id)}
        data-testid={`workspace-switch-${keyPrefix}${p.id}`}
        className={cn(
          "flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
          activeProjectId === p.id && "bg-primary/10 text-foreground"
        )}
      >
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className="truncate">{p.name}</span>
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
        {activeProjectId === p.id && <CheckIcon className="size-4 shrink-0 text-primary" />}
      </button>
    )
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={triggerLabel}
                data-testid="workspace-switcher"
                className="size-10 rounded-2xl text-muted-foreground transition-all hover:rounded-xl hover:text-foreground"
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

        <PopoverContent side="right" align="start" className="w-64 p-1">
          <div className="px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("heading")}
          </div>
          <ScrollArea className="max-h-72">
            <div className="flex flex-col">
              {visible.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">{t("empty")}</div>
              ) : (
                <>
                  {recent.length > 0 && (
                    <>
                      <div className="px-2 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t("recentHeading")}
                      </div>
                      {recent.map((p) => renderRow(p, "recent-"))}
                      <Separator className="my-1" />
                    </>
                  )}
                  {visible.map((p) => renderRow(p))}
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
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
            >
              <FolderOpenIcon className="size-4 text-muted-foreground" />
              {t("openFolder")}
            </button>
          )}
          <button
            type="button"
            onClick={() => openManage(true)}
            data-testid="workspace-switcher-new"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
          >
            <PlusIcon className="size-4 text-muted-foreground" />
            {t("newWorkspace")}
          </button>
          <button
            type="button"
            onClick={() => openManage(false)}
            data-testid="workspace-switcher-manage"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
          >
            <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
            {t("manage")}
          </button>
        </PopoverContent>
      </Popover>

      <WorkspaceManageDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        autoCreateOnOpen={manageAutoCreate}
      />
    </>
  )
}

export default WorkspaceSwitcher
