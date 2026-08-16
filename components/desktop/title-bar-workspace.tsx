"use client"

/**
 * Title-bar active-workspace indicator. Reuses the project store (active
 * project) and `primaryRootOf` to show the current workspace name (falling back
 * to the primary root's folder name). Clicking opens the command palette, whose
 * "workspaces" group switches projects. Renders `null` when no project is
 * active. Mounting is gated by the parent (`barItems.workspace`).
 */

import { useTranslations } from "next-intl"
import { FolderIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { requestCommandPalette } from "@/lib/shell/command-palette-request"
import { primaryRootOf } from "@/lib/workspace/roots"
import { useProjectStore } from "@/stores/project/project-store"

/** Last path segment of a filesystem path (posix or windows separators). */
function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

export function TitleBarWorkspace({ className }: { className?: string }) {
  const t = useTranslations("desktop.titleBar")
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)

  const active = projects.find((p) => p.id === activeProjectId) ?? null
  if (!active) return null

  const primary = primaryRootOf(active)
  const name = active.name.trim() || (primary ? basename(primary.path) : t("workspaceUntitled"))

  // Not a forged ⌘K: that keystroke was hard-wired to `ctrlKey`, so on macOS
  // the palette (which listens for ⌘) never opened from this pill.
  const openCommandPalette = () => requestCommandPalette()

  return (
    <button
      type="button"
      onClick={openCommandPalette}
      aria-label={t("workspace")}
      title={name}
      data-testid="title-bar-workspace"
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className
      )}
    >
      <FolderIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="max-w-[16ch] truncate">{name}</span>
    </button>
  )
}
