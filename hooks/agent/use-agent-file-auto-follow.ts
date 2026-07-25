"use client"

import { useEffect, useRef } from "react"
import type { UIMessage } from "ai"
import { extractAgentFileActivity } from "@/lib/agent-team/file-activity"
import { openInProjectEditor, reflectEditInProjectEditor } from "@/lib/files/project-editor-bridge"
import { resolveLinkPath } from "@/lib/terminal/terminal-links"

interface UseAgentFileAutoFollowArgs {
  parts: UIMessage["parts"]
  isStreaming: boolean
  projectRoot?: string | null
}

export function useAgentFileAutoFollow({
  parts,
  isStreaming,
  projectRoot,
}: UseAgentFileAutoFollowArgs): void {
  const followedRef = useRef(new Set<string>())

  useEffect(() => {
    if (!isStreaming) return

    parts.forEach((part, index) => {
      const candidate = part as {
        type?: string
        state?: string
        input?: Record<string, unknown>
        toolCallId?: string
      }
      if (!candidate.type?.startsWith("tool-") || !candidate.input) return
      const activity = extractAgentFileActivity(
        candidate.type.slice("tool-".length),
        candidate.input
      )
      if (!activity) return

      const ready =
        activity.timing === "start"
          ? candidate.state !== "input-streaming"
          : candidate.state === "output-available"
      if (!ready) return

      const key = `${candidate.toolCallId ?? index}:${activity.timing}`
      if (followedRef.current.has(key)) return
      followedRef.current.add(key)

      const absolutePath = resolveLinkPath(projectRoot, activity.path)
      // A completed write/edit reflects as an undo-able live edit where the
      // editor supports it; a read just opens + reveals.
      if (activity.timing === "success") {
        reflectEditInProjectEditor(absolutePath, activity.line, activity.column)
      } else {
        openInProjectEditor(absolutePath, activity.line, activity.column)
      }
    })
  }, [isStreaming, parts, projectRoot])
}
