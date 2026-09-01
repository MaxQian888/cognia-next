"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, FolderIcon } from "lucide-react"

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import {
  useWorkspacePickerDialogs,
  WorkspacePickerList,
} from "@/components/workspace/workspace-picker-list"
import { WorkspaceContextBar } from "@/components/workspace/workspace-context-bar"
import { useProjectStore } from "@/stores/project/project-store"
import { cn } from "@/lib/utils"

/**
 * Active workspace in the mobile shell header, and the way to change it.
 *
 * This was a read-only `<span>` carrying a comment that remote switching from
 * mobile was deferred. That had stopped being true: the full switcher was
 * already reachable on a phone through the nav Sheet, then the guild rail, as
 * a 40px icon opening a Popover inside a Sheet. So the two surfaces disagreed,
 * and the one the user actually looks at was the inert one.
 *
 * The name in the header IS the switcher now, which is where every product
 * with more than one workspace puts it. The list is the same
 * `WorkspacePickerList` the desktop popover renders, at touch density, and the
 * dialogs it opens are mounted outside the Drawer because a Drawer unmounts
 * its children when it closes.
 *
 * The sheet carries the branch under the list, which is the same pair the
 * desktop title bar shows. The header row itself stays ONE chip on purpose: it
 * already holds the character header, the background-runs chip and the
 * missing-credential warning, and a second permanent control there is how a
 * 375px header starts truncating the conversation title. Cursor Mobile makes
 * the same call, asking for the repository and then the branch in one
 * progressive sheet rather than putting both in the chrome.
 */
export function MobileWorkspaceChip({ className }: { className?: string }) {
  const t = useTranslations("mobile.workspace")
  const [open, setOpen] = useState(false)
  const { actions, element: dialogs } = useWorkspacePickerDialogs()
  const name = useProjectStore((s) => {
    const id = s.activeProjectId
    return id ? (s.projects.find((p) => p.id === id)?.name ?? null) : null
  })

  if (!name) return null

  return (
    <>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>
          <button
            type="button"
            data-testid="mobile-workspace-chip"
            aria-label={t("switchLabel", { name })}
            className={cn(
              "flex items-center gap-1 rounded-pill bg-muted/60 px-2 py-1 text-[10px] text-muted-foreground",
              className
            )}
          >
            <FolderIcon className="size-3 shrink-0" />
            <span className="max-w-24 truncate">{name}</span>
            <ChevronDownIcon className="size-3 shrink-0" />
          </button>
        </DrawerTrigger>
        <DrawerContent data-testid="mobile-workspace-drawer">
          <DrawerHeader className="sr-only">
            <DrawerTitle>{t("drawerTitle")}</DrawerTitle>
            <DrawerDescription>{t("drawerDescription")}</DrawerDescription>
          </DrawerHeader>
          <div className="px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
            <WorkspacePickerList
              actions={actions}
              density="comfortable"
              onSwitched={() => setOpen(false)}
            />
            {/*
              Self-hides where Source Control cannot run or no repository is
              bound, so the sheet does not grow a dead row on a phone that has
              no host to ask.
            */}
            <WorkspaceContextBar layout="stacked" className="mt-1 [&:empty]:hidden" />
          </div>
        </DrawerContent>
      </Drawer>

      {dialogs}
    </>
  )
}

export default MobileWorkspaceChip
