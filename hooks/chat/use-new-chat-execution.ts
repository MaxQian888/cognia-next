"use client"

import { useCallback, useMemo, useState } from "react"

import { primaryRootOf } from "@/lib/workspace/roots"
import { useProjectStore } from "@/stores/project/project-store"
import type { NewChatExecutionSelection } from "@/components/chat/new-chat-execution-picker"

export interface NewChatExecution {
  value: NewChatExecutionSelection
  setValue: (value: NewChatExecutionSelection) => void
  /**
   * The active workspace's primary root, or undefined when it has none.
   *
   * A rootless workspace (Default, before anything is opened or created) has
   * nothing for "Local" to mean: the session falls back to a managed workspace
   * regardless, so offering the choice would be offering a lie. Callers use
   * this to decide whether to render the picker at all.
   */
  rootDir: string | undefined
}

/**
 * Where a NEW conversation will run: the local checkout, or an isolated
 * worktree off a chosen base.
 *
 * Extracted from `desktop-chat-workspace.tsx`, which held the only copy, so the
 * mobile shell can offer the same choice without a second set of defaulting
 * rules. Mobile created every session with a bare `create({ kind: "direct" })`
 * and therefore always took the workspace default, with no way to say
 * otherwise from a phone.
 *
 * The override is keyed by workspace id rather than stored globally: switching
 * workspaces must not carry a choice made about a different repository into it,
 * and the per-workspace `defaultExecutionLocation` is the right answer again
 * the moment the override no longer applies.
 */
export function useNewChatExecution(): NewChatExecution {
  const activeProject = useProjectStore((s) =>
    s.projects.find((project) => project.id === s.activeProjectId)
  )
  const [override, setOverride] = useState<{
    projectId: string
    value: NewChatExecutionSelection
  } | null>(null)

  const value = useMemo<NewChatExecutionSelection>(
    () =>
      activeProject && override?.projectId === activeProject.id
        ? override.value
        : {
            location: activeProject?.defaultExecutionLocation ?? "managedWorktree",
            base: { kind: "workingState" },
          },
    [activeProject, override]
  )

  const setValue = useCallback(
    (next: NewChatExecutionSelection) => {
      if (activeProject) setOverride({ projectId: activeProject.id, value: next })
    },
    [activeProject]
  )

  return {
    value,
    setValue,
    rootDir: activeProject ? primaryRootOf(activeProject)?.path : undefined,
  }
}
