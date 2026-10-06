"use client"

import type { ReactNode } from "react"
import { openInProjectEditor } from "@/lib/files/project-editor-bridge"
import type { ProjectFileReference } from "@/lib/files/project-file-reference"
import { openFileViewer } from "@/lib/file-viewer/open"

interface ProjectFileLinkProps {
  target: ProjectFileReference
  children: ReactNode
  onOpenFile?: (target: ProjectFileReference) => void
  /**
   * The workspace root this message was rendered against, if known.
   *
   * Only a tie-breaker for root resolution — a reference into another open
   * checkout still resolves without it.
   */
  projectRoot?: string | null
}

export function ProjectFileLink({
  target,
  children,
  onOpenFile,
  projectRoot,
}: ProjectFileLinkProps) {
  return (
    <button
      type="button"
      // `chat-link` (app/typeset.css, ADR-0218): one link style for web and
      // file links, following the same colour / underline settings. Preflight
      // already gives a button `font: inherit`, so the link weight applies.
      className="chat-link inline cursor-pointer"
      onClick={() => {
        if (onOpenFile) {
          onOpenFile(target)
          return
        }
        // A live editor rooted at this path wins: an editable buffer with LSP
        // beats a read-only copy of the same file.
        if (!openInProjectEditor(target.absolutePath, target.line, target.column)) {
          openFileViewer(target.absolutePath, {
            line: target.line,
            column: target.column,
            preferredRoots: projectRoot ? [projectRoot] : undefined,
          })
        }
      }}
    >
      {children}
    </button>
  )
}
