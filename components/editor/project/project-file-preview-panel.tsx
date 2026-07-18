"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { ContextCapabilityUnavailable } from "@/components/context-workbench/context-capability-unavailable"

export function ProjectFilePreviewPanel({
  relPath,
  content,
}: {
  relPath: string
  content: string
}) {
  const t = useTranslations("projectEditor.workbench")
  const extension = relPath.split(".").pop()?.toLowerCase()
  const formattedJson = useMemo(() => {
    if (extension !== "json") return null
    try {
      return JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      return content
    }
  }, [content, extension])

  if (extension === "md" || extension === "markdown") {
    return (
      <div className="h-full overflow-auto p-4" data-testid="project-markdown-preview">
        <MarkdownRenderer content={content} />
      </div>
    )
  }

  if (extension === "html" || extension === "htm") {
    return (
      <iframe
        className="h-full w-full border-0 bg-white"
        sandbox="allow-forms allow-modals allow-popups allow-scripts"
        srcDoc={content}
        title={t("previewFrameTitle")}
        data-testid="project-html-preview"
      />
    )
  }

  if (formattedJson !== null) {
    return (
      <pre className="h-full overflow-auto p-4 text-xs" data-testid="project-json-preview">
        {formattedJson}
      </pre>
    )
  }

  return <ContextCapabilityUnavailable capability="preview" />
}
