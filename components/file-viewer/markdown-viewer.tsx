"use client"

import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import type { FileViewerRenderProps } from "@/lib/file-viewer/types"

/**
 * Markdown preview. Keeps `project-markdown-preview` so the project workbench's
 * existing tests describe the same surface they always did.
 */
export default function MarkdownViewer({ text }: FileViewerRenderProps) {
  return (
    <div className="h-full overflow-auto p-4" data-testid="project-markdown-preview">
      <MarkdownRenderer content={text} rhythm="document" />
    </div>
  )
}
