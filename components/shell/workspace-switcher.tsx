"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, FolderIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { useProjectStore } from "@/stores/project/project-store"
import {
  useWorkspacePickerRequests,
  WorkspacePickerList,
} from "@/components/workspace/workspace-picker-list"
import { useOverlaySide } from "./rail-overlay-side"
import { useSidebarRowRoving } from "./sidebar-row-roving"

/**
 * Rail entry point for the active workspace. The trigger shows the active
 * workspace's initial, or a folder icon when none is active. The list and its
 * dialogs live in `components/workspace/workspace-picker-list.tsx` so the
 * mobile header chip opens exactly the same thing in a Drawer.
 *
 * Switching drives `setActiveProject`, which re-binds the Git panel and
 * terminal scope and feeds the cwd chain.
 *
 * On the rail the trigger is one of the column's buttons, so it takes its
 * place in the rail's roving order (`sidebar-row-roving.tsx`): no tab stop of
 * its own, reached with the arrow keys like its neighbours. The wide trigger
 * sits in the title bar, outside any roving scope, and keeps its tab stop.
 */
interface WorkspaceSwitcherProps {
  /**
   * `rail` (the default) is the square initial in the icon column, with a
   * tooltip for the name and a popover opening inward — rightward from a left
   * rail, leftward from a right one (`OverlaySideContext`, provided by the
   * rail). `wide` is a text
   * trigger for the title bar's start zone above the expanded sidebar:
   * initial, name, chevron, with the popover opening downward under it. Same
   * list, same actions.
   */
  variant?: "rail" | "wide"
  className?: string
}

export function WorkspaceSwitcher({ variant = "rail", className }: WorkspaceSwitcherProps = {}) {
  const t = useTranslations("workspace.switcher")
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const [open, setOpen] = useState(false)
  // Requests to the shell's one dialog host, not dialogs of its own: there
  // are up to three switchers on the desktop shell at once.
  const actions = useWorkspacePickerRequests()

  const active = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  )

  const triggerLabel = active ? t("active", { name: active.name }) : t("none")
  const initial = active?.name.trim().charAt(0).toUpperCase()
  const wide = variant === "wide"
  const overlaySide = useOverlaySide()
  // Never the selected destination, so it holds the tab stop only when the
  // scope hands it one (nothing else claimed it, or the user arrowed here).
  const roving = useSidebarRowRoving(wide ? undefined : "workspace-switcher", false)

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
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
                  {...roving.rowProps}
                  tabIndex={roving.tabIndex}
                  onKeyDown={roving.onKeyDown}
                  onFocus={roving.onFocus}
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
            <TooltipContent side={overlaySide}>{triggerLabel}</TooltipContent>
          </Tooltip>
        )}

        <PopoverContent side={wide ? "bottom" : overlaySide} align="start" className="w-72 p-1">
          <WorkspacePickerList actions={actions} onSwitched={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </>
  )
}

export default WorkspaceSwitcher
