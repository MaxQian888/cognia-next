"use client"

import { useEffect } from "react"

import { isTauri } from "@/lib/platform/detect"
import { captureProjectRepository } from "@/lib/workspace/project-repository"
import { primaryRootOf } from "@/lib/workspace/roots"
import { useProjectStore } from "@/stores/project/project-store"
import type { Project } from "@/types"

/** Waits for boot to settle before reading every workspace's checkout. */
export const PROJECT_REPOSITORY_SCAN_DELAY_MS = 5_000

type Capture = typeof captureProjectRepository

function primaryPaths(projects: readonly Project[]): Map<string, string> {
  const paths = new Map<string, string>()
  for (const project of projects) {
    const path = primaryRootOf(project)?.path?.trim()
    if (path && !project.isArchived) paths.set(project.id, path)
  }
  return paths
}

/**
 * Record each workspace's repository from its checkout (ADR-0224 A11), so an
 * always-on host that lacks the folder can clone it: once after boot for
 * every workspace, then whenever a workspace's primary folder changes.
 * Desktop only, the shell that has the folders and git.
 */
export function ProjectRepositoryInitializer({
  capture = captureProjectRepository,
}: {
  capture?: Capture
}) {
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let known = new Map<string, string>()

    const read = async (ids: readonly string[]) => {
      for (const id of ids) {
        if (cancelled) return
        const project = useProjectStore.getState().projects.find((item) => item.id === id)
        if (!project) continue
        await capture(project, {
          update: (projectId, repository) =>
            useProjectStore.getState().updateProject(projectId, { repository }),
        }).catch(() => undefined)
      }
    }

    const scanAll = () => {
      const { projects, loaded } = useProjectStore.getState()
      if (!loaded) return false
      known = primaryPaths(projects)
      void read([...known.keys()])
      return true
    }

    // The first scan waits for the delay and for the list to load, whichever
    // comes last; after it, only workspaces whose primary folder changed.
    let scanned = false
    let delayElapsed = false
    const timer = setTimeout(() => {
      delayElapsed = true
      scanned = scanAll()
    }, PROJECT_REPOSITORY_SCAN_DELAY_MS)

    const unsubscribe = useProjectStore.subscribe((next, previous) => {
      if (!scanned) {
        if (delayElapsed && next.loaded && !previous.loaded) scanned = scanAll()
        return
      }
      if (next.projects === previous.projects) return
      const current = primaryPaths(next.projects)
      const moved = [...current].filter(([id, path]) => known.get(id) !== path).map(([id]) => id)
      known = current
      if (moved.length > 0) void read(moved)
    })

    return () => {
      cancelled = true
      clearTimeout(timer)
      unsubscribe()
    }
  }, [capture])

  return null
}

export default ProjectRepositoryInitializer
