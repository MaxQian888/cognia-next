"use client"

import type { ReactNode } from "react"
import { openInProjectEditor } from "@/lib/files/project-editor-bridge"
import type { ProjectFileReference } from "@/lib/files/project-file-reference"
import { useFileViewerStore } from "@/stores/terminal/file-viewer-store"

interface ProjectFileLinkProps {
  target: ProjectFileReference
  children: ReactNode
  onOpenFile?: (target: ProjectFileReference) => void
}

export function ProjectFileLink({ target, children, onOpenFile }: ProjectFileLinkProps) {
  const openFileViewer = useFileViewerStore((state) => state.openFile)

  return (
    <button
      type="button"
      className="inline cursor-pointer [font:inherit] text-primary underline underline-offset-2 hover:text-primary/80"
      onClick={() => {
        if (onOpenFile) {
          onOpenFile(target)
          return
        }
        if (!openInProjectEditor(target.absolutePath, target.line, target.column)) {
          openFileViewer(target.absolutePath, target.line, target.column)
        }
      }}
    >
      {children}
    </button>
  )
}
