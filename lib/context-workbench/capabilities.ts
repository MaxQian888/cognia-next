import type { ContextCapability } from "@/types/context-workbench"
import { extensionOf } from "@/lib/file-viewer/probe"
import { resolveFileViewer } from "@/lib/file-viewer/registry"

export type ContextCapabilityInput =
  | { kind: "project-file"; previewable: boolean }
  | { kind: "canvas-document"; runnable: boolean }
  | {
      kind: "artifact"
      previewable: boolean
      runnable: boolean
      workspaceAvailable: boolean
    }
  | { kind: "workflow" }
  | { kind: "session"; workspaceAvailable: boolean }

export function resolveContextCapabilities(input: ContextCapabilityInput): ContextCapability[] {
  // A session is not a document: there is nothing to comment on, review or ask
  // the AI about at the session level, so it gets its own (much smaller) seed
  // instead of the document base set below.
  if (input.kind === "session") {
    const sessionCapabilities = new Set<ContextCapability>(["inspect", "preview", "history"])
    if (input.workspaceAvailable) sessionCapabilities.add("workspace")
    return [...sessionCapabilities]
  }

  const capabilities = new Set<ContextCapability>(["ai", "comments", "inspect", "review"])
  if (input.kind === "project-file") {
    capabilities.add("history")
    if (input.previewable) capabilities.add("preview")
  } else if (input.kind === "canvas-document") {
    capabilities.add("preview")
    capabilities.add("history")
    if (input.runnable) capabilities.add("run")
  } else if (input.kind === "artifact") {
    capabilities.add("history")
    if (input.previewable) capabilities.add("preview")
    if (input.runnable) capabilities.add("run")
    if (input.workspaceAvailable) capabilities.add("workspace")
  } else {
    capabilities.add("run")
    capabilities.add("templates")
    capabilities.add("history")
  }
  return [...capabilities]
}

/**
 * Whether the project workbench should offer a Preview tab for this file.
 *
 * Answered by the viewer registry rather than a local list, so the tab and the
 * thing it opens can never disagree. The answer is unchanged from the hard-coded
 * list it replaces: the registry's text fallback matches on
 * `source === "terminal"`, so nothing claims a `.py` here.
 *
 * The import chain stays free of React on purpose — this module is pulled in by
 * the artifact dock, the canvas side panels and the workflow sidebar as well as
 * the project workbench, and the registry reaches its viewers through lazy
 * `import()` rather than holding them.
 */
export function isProjectFilePreviewable(relPath: string): boolean {
  return resolveFileViewer({ extension: extensionOf(relPath), source: "project-preview" }) !== null
}
