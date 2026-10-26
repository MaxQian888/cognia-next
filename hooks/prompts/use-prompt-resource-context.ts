"use client"

/**
 * The workspace the Prompt Center reads instruction files and workspace
 * instructions for (ADR-0236 §4). The section names it explicitly, defaulting
 * to the active workspace; it never follows whichever chat is on screen.
 */

import { useMemo } from "react"
import type { PromptResourceContext } from "@/lib/prompts/resources"
import { allRootPaths } from "@/lib/workspace/roots"
import { useProjectStore } from "@/stores/project/project-store"

export function usePromptResourceContext(workspaceId: string | null): PromptResourceContext {
  const project = useProjectStore((state) =>
    workspaceId ? state.projects.find((candidate) => candidate.id === workspaceId) : undefined
  )
  return useMemo(
    () =>
      project
        ? {
            workspace: {
              id: project.id,
              name: project.name,
              roots: allRootPaths(project),
              ...(project.customInstructions
                ? { customInstructions: project.customInstructions }
                : {}),
            },
          }
        : {},
    [project]
  )
}
