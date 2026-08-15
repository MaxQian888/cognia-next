"use client"

import { useMemo } from "react"
import type { FileViewerRenderProps } from "@/lib/file-viewer/types"

/**
 * Pretty-printed JSON, falling back to the raw text when it does not parse.
 *
 * Deliberately still a `<pre>` rather than `components/shared/json-tree.tsx`:
 * swapping in a collapsible tree is a behaviour change for the project preview,
 * and that component's exported `JsonTreeProps` does not match the props it
 * actually takes — a trap to walk into on purpose, not by accident.
 */
export default function JsonViewer({ text }: FileViewerRenderProps) {
  const formatted = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      // An unparseable file is still worth reading; showing nothing would be a
      // worse answer than showing what is there.
      return text
    }
  }, [text])

  return (
    <pre className="h-full overflow-auto p-4 text-xs" data-testid="project-json-preview">
      {formatted}
    </pre>
  )
}
