"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, FolderIcon, PlusIcon, SlidersHorizontalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { useProjectStore } from "@/stores/project/project-store"
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

  const visible = useMemo(
    () => projects.filter((p) => !p.isArchived).sort((a, b) => a.name.localeCompare(b.name)),
    [projects]
  )
  const active = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  )

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
          <ScrollArea className="max-h-64">
            <div className="flex flex-col">
              {visible.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">{t("empty")}</div>
              ) : (
                visible.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleSwitch(p.id)}
                    data-testid={`workspace-switch-${p.id}`}
                    className={cn(
                      "flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                      activeProjectId === p.id && "bg-primary/10 text-foreground"
                    )}
                  >
                    <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{p.name}</span>
                      {p.rootDir && (
                        <span className="block truncate font-mono text-[10px] text-muted-foreground">
                          {p.rootDir}
                        </span>
                      )}
                    </span>
                    {activeProjectId === p.id && (
                      <CheckIcon className="size-4 shrink-0 text-primary" />
                    )}
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
          <Separator className="my-1" />
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
