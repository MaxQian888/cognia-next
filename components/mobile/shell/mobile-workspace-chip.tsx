"use client"

import { useTranslations } from "next-intl"
import { FolderIcon } from "lucide-react"
import { useProjectStore } from "@/stores/project/project-store"
import { cn } from "@/lib/utils"

/**
 * Read-only active-workspace indicator for the mobile shell header. The active
 * pointer rides the existing AppSettings companion sync, so this reflects the
 * workspace selected on the desktop. Remote switching from mobile is deferred —
 * this is display-only. Renders nothing when no workspace is active.
 */
export function MobileWorkspaceChip({ className }: { className?: string }) {
  const t = useTranslations("mobile.workspace")
  const name = useProjectStore((s) => {
    const id = s.activeProjectId
    return id ? (s.projects.find((p) => p.id === id)?.name ?? null) : null
  })
  if (!name) return null
  return (
    <span
      data-testid="mobile-workspace-chip"
      aria-label={t("activeLabel", { name })}
      className={cn(
        "flex items-center gap-1 rounded-pill bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground",
        className
      )}
    >
      <FolderIcon className="size-3 shrink-0" />
      <span className="max-w-24 truncate">{name}</span>
    </span>
  )
}

export default MobileWorkspaceChip
