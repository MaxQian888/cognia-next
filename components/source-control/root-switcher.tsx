"use client"

/**
 * RootSwitcher — for multi-root workspaces, lets the user point the Source
 * Control panel at a specific mounted root. The always-mounted
 * `useGitBranchIndicator` auto-binds to the active project's PRIMARY root on
 * workspace switch; this switcher overrides that binding to a secondary root
 * without fighting the auto-follow (the follow guard tracks the primary, so a
 * manual pick persists until the workspace itself changes).
 *
 * Renders nothing for single-root (or rootless) workspaces.
 */

import { useTranslations } from "next-intl"
import { CheckIcon, ChevronsUpDownIcon, FolderGitIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useGitStore } from "@/stores/git/git-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { WorkspaceRoot } from "@/types/workspace"

const EMPTY_ROOTS: WorkspaceRoot[] = []

function rootLabel(root: WorkspaceRoot): string {
  if (root.label) return root.label
  const segments = root.path.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? root.path
}

interface RootSwitcherProps {
  /**
   * Explicit workspace roots for resource-scoped hosts such as the chat
   * Workbench. The full Source Control route omits this and keeps following the
   * globally active workspace.
   */
  roots?: WorkspaceRoot[]
}

export function RootSwitcher({ roots: explicitRoots }: RootSwitcherProps = {}) {
  const t = useTranslations("sourceControl")
  const rootDir = useGitStore((s) => s.rootDir)
  const setRootDir = useGitStore((s) => s.setRootDir)
  const activeProjectRoots = useProjectStore((s) => {
    const id = s.activeProjectId
    const project = id ? s.projects.find((p) => p.id === id) : undefined
    return project?.roots ?? EMPTY_ROOTS
  })
  const roots = explicitRoots ?? activeProjectRoots

  // Only meaningful when the active workspace mounts more than one directory.
  if (roots.length <= 1) return null

  const current = roots.find((r) => r.path === rootDir)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-1.5 text-xs"
          aria-label={t("roots.switchRoot")}
          data-testid="root-switcher"
        >
          <FolderGitIcon className="size-3.5" />
          <span className="max-w-32 truncate">
            {current ? rootLabel(current) : t("roots.select")}
          </span>
          <ChevronsUpDownIcon className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {roots.map((r) => (
          <DropdownMenuItem
            key={r.id}
            onSelect={() => setRootDir(r.path)}
            data-testid={`root-option-${r.id}`}
          >
            <CheckIcon
              className={cn("size-3.5", r.path === rootDir ? "opacity-100" : "opacity-0")}
            />
            <span className="min-w-0 flex-1 truncate" title={r.path}>
              {rootLabel(r)}
            </span>
            {r.isPrimary && (
              <span className="ml-auto text-[10px] text-muted-foreground">
                {t("roots.primary")}
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
