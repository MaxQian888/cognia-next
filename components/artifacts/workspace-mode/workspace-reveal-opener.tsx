"use client"

import { useEffect } from "react"
import type { ChatSession } from "@cognia/agent-config-types"
import { useClientLiveQuery } from "@/hooks/data"
import { getSession } from "@/lib/db/sessions"
import { registerProjectEditorOpener } from "@/lib/files/project-editor-bridge"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { resolveSessionProjectRoot } from "@/lib/workspace/roots"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"

/**
 * Keeps a dormant project-editor bridge registered for the active chat root.
 * Terminal links can therefore queue a reveal even while Artifact mode owns
 * the dock body and the real workspace editor is not mounted yet.
 */
export function WorkspaceRevealOpener() {
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const session = useClientLiveQuery<ChatSession | undefined>(
    () => (activeSessionId ? getSession(activeSessionId) : Promise.resolve(undefined)),
    [activeSessionId],
    undefined
  )
  const projects = useProjectStore((state) => state.projects)
  const rootPath = resolveSessionProjectRoot(session, projects).root?.path

  useEffect(() => {
    if (!session || !rootPath || !hasWorkspaceFsBackend()) return
    return registerProjectEditorOpener({
      root: rootPath,
      open: (relPath, line, column) => {
        useArtifactDockLayoutStore.getState().revealWorkspaceFile({
          sessionId: session.id,
          rootPath,
          relPath,
          line,
          column,
        })
      },
    })
  }, [rootPath, session])

  return null
}
