import type { ContextCapability } from "@/types/context-workbench"

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

export function isProjectFilePreviewable(relPath: string): boolean {
  const extension = relPath.split(".").pop()?.toLowerCase()
  return ["md", "markdown", "html", "htm", "json"].includes(extension ?? "")
}
