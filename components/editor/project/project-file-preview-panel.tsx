"use client"

import { useMemo } from "react"
import { FilePreviewSurface } from "@/components/file-viewer/file-preview-surface"
import { ContextCapabilityUnavailable } from "@/components/context-workbench/context-capability-unavailable"
import { extensionOf } from "@/lib/file-viewer/probe"
import { resolveFileViewer } from "@/lib/file-viewer/registry"

/**
 * The project workbench's Preview tab.
 *
 * A thin wrapper over the shared surface now, keeping its own name, path and
 * props so `project-context-workbench.tsx` needs no change. It passes the live
 * editor draft as `providedText`, which is what makes this the one preview path
 * that never touches the disk — an unsaved buffer previews exactly as the user
 * sees it, and the panel gains no filesystem reach it did not have before.
 */
export function ProjectFilePreviewPanel({
  relPath,
  content,
}: {
  relPath: string
  content: string
}) {
  const request = useMemo(
    () => ({
      // Keyed by path and content, so editing the buffer re-renders the preview
      // while merely re-rendering the panel does not restart it.
      requestId: `project-preview:${relPath}:${content.length}`,
      source: "project-preview" as const,
      relPath,
      displayName: relPath,
      providedText: content,
    }),
    [content, relPath]
  )

  // The capability gate should already have kept this panel off a file nothing
  // can render; this is the belt to that braces, and it keeps the panel's
  // previous "unavailable" state rather than showing an error.
  if (!resolveFileViewer({ extension: extensionOf(relPath), source: "project-preview" })) {
    return <ContextCapabilityUnavailable capability="preview" />
  }

  return <FilePreviewSurface request={request} />
}
