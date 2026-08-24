"use client"

/**
 * A2UI Markdown component.
 *
 * A thin wrapper over `components/chat/markdown-renderer.tsx` rather than a
 * second markdown pipeline: the chat renderer already carries the sanitize
 * schema, URL transform, Shiki code blocks, Mermaid diagrams, math, alerts and
 * workspace file links. Re-implementing any of that here would fork the
 * security policy — an A2UI surface authored by a plugin is exactly where a
 * weaker sanitizer would be exploited first.
 *
 * `rhythm` defaults to `"document"` (not the renderer's chat default): an A2UI
 * markdown block is a body of prose inside a panel or artifact, not a
 * conversational turn.
 */

import { memo, useCallback } from "react"
import { cn } from "@/lib/utils"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import type { ProjectFileReference } from "@/lib/files/project-file-reference"
import type { A2UIComponentProps } from "@/types/a2ui/schema"
import type { A2UIMarkdownComponent } from "@/types/artifact/a2ui"
import { useA2UIData } from "../a2ui-context"

export type { A2UIMarkdownComponent }

export const A2UIMarkdown = memo(function A2UIMarkdown({
  component,
  onAction,
}: A2UIComponentProps<A2UIMarkdownComponent>) {
  const { resolveString } = useA2UIData()
  const content = resolveString(component.content, "")

  const openFileAction = component.openFileAction
  const handleOpenProjectFile = useCallback(
    (target: ProjectFileReference) => {
      if (!openFileAction) return
      onAction(openFileAction, {
        path: target.absolutePath,
        ...(target.line === undefined ? {} : { line: target.line }),
        ...(target.column === undefined ? {} : { column: target.column }),
      })
    },
    [onAction, openFileAction]
  )

  return (
    <MarkdownRenderer
      content={content}
      className={cn(component.className)}
      enableMermaid={component.mermaid ?? true}
      enableMath={component.math ?? true}
      showLineNumbers={component.codeLineNumbers ?? true}
      wrapLines={component.codeWrap ?? false}
      rhythm={component.rhythm ?? "document"}
      projectRoot={component.projectRoot ?? null}
      onOpenProjectFile={openFileAction ? handleOpenProjectFile : undefined}
    />
  )
})
