"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { ProjectCoordinatorConfig } from "@/types"
import { resolveCoordinatorConfig } from "@/lib/project-coordinator/config"
import { pauseProject, resumeProject } from "@/lib/project-coordinator/pause"
import { useProjectStore } from "@/stores/project/project-store"

export interface ProjectPauseControl {
  /** The recorded pause, or undefined while the project runs. */
  paused: ProjectCoordinatorConfig["paused"]
  /** Coordination is on — pausing means nothing otherwise. */
  enabled: boolean
  busy: boolean
  pause: (reason?: string) => Promise<void>
  resume: () => Promise<void>
}

/** Pause state of one workspace's coordination and the two actions on it (ADR-0204). */
export function useProjectPause(projectId: string): ProjectPauseControl {
  const t = useTranslations("projectCoordinator.pause")
  const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId))
  const config = resolveCoordinatorConfig(project)
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (action: () => Promise<void>, failure: "pauseFailed" | "resumeFailed") => {
      setBusy(true)
      try {
        await action()
      } catch (error) {
        toast.error(t(failure, { error: error instanceof Error ? error.message : String(error) }))
      } finally {
        setBusy(false)
      }
    },
    [t]
  )

  return {
    paused: config.paused,
    enabled: config.enabled,
    busy,
    pause: useCallback(
      (reason?: string) => run(() => pauseProject(projectId, { reason }), "pauseFailed"),
      [projectId, run]
    ),
    resume: useCallback(
      () => run(() => resumeProject(projectId), "resumeFailed"),
      [projectId, run]
    ),
  }
}
