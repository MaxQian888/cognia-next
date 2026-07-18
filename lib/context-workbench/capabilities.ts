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

export function resolveContextCapabilities(input: ContextCapabilityInput): ContextCapability[] {
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
