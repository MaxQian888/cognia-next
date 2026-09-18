"use client"

/**
 * Title-bar active-workspace entry point. Renders the real workspace
 * switcher (`variant="wide"` — initial, name, chevron) so clicking opens the
 * project picker popover directly instead of detouring through the command
 * palette. Renders `null` when no project is active. Mounting is gated by the
 * parent (`barItems.workspace`).
 */

import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher"
import { useTitleBarProjectionState } from "@/components/shell/title-bar-outlets"
import { useProjectStore } from "@/stores/project/project-store"

export function TitleBarWorkspace({ className }: { className?: string }) {
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  // On `/` the conversation sidebar projects its header — which already holds
  // this same switcher (`WorkspaceContextBar`) — into the bar's start zone.
  // Mounting a second one here is how two identical chips ended up side by
  // side. No provider (tests, non-desktop shells) reports all-false.
  const projected = useTitleBarProjectionState()

  if (projected.start) return null
  if (!projects.some((p) => p.id === activeProjectId)) return null
  return <WorkspaceSwitcher variant="wide" className={className} />
}
