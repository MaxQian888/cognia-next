import type { ComponentType } from "react"

export type ContextWorkbenchMode = "collapsed" | "narrow" | "wide" | "focus"
export type ContextWorkbenchPlacement = "adjacent-editor" | "chat-dock" | "mobile-sheet"
export type ContextPanelRetention = "stateful" | "ephemeral"
export type ContextPanelMode = Exclude<ContextWorkbenchMode, "collapsed">
export type ContextCapability =
  | "ai"
  | "comments"
  | "inspect"
  | "review"
  | "preview"
  | "run"
  | "templates"
  | "workspace"
  | "history"
export type CanonicalContextActivity =
  "ai" | "comments" | "inspect" | "review" | "preview-run" | "templates"
export type ContextActivity = CanonicalContextActivity | (string & {})

export interface TextSelectionCoordinates {
  kind: "text"
  start: number
  end: number
}

export interface CanvasSelectionCoordinates {
  kind: "canvas"
  blockIds: string[]
  text?: TextSelectionCoordinates
}

export interface WorkflowSelectionCoordinates {
  kind: "workflow"
  nodeIds: string[]
  edgeIds: string[]
}

export type ContextResource =
  | {
      kind: "canvas-document"
      documentId: string
      revision: string
      selection?: CanvasSelectionCoordinates
      capabilities: ContextCapability[]
    }
  | {
      kind: "project-file"
      projectId: string
      rootId: string
      relPath: string
      contentHash: string
      mtime?: number
      draftVersion: number
      selection?: TextSelectionCoordinates
      capabilities: ContextCapability[]
    }
  | {
      kind: "artifact"
      artifactId: string
      version: string
      selection?: TextSelectionCoordinates
      capabilities: ContextCapability[]
    }
  | {
      kind: "workflow"
      workflowId: string
      editorRevision: string
      selection?: WorkflowSelectionCoordinates
      capabilities: ContextCapability[]
    }

export type ContextResourceKind = ContextResource["kind"]

export interface ContextPanelRenderProps {
  workbenchInstanceId: string
  resource: ContextResource
  active: boolean
}

export interface ContextPanelDefinition {
  id: string
  activity: ContextActivity
  labelKey: string
  label?: string
  icon?: ComponentType<{ className?: string }>
  order?: number
  appliesTo: (resource: ContextResource) => boolean
  requiredCapabilities?: ContextCapability[]
  requiredPermissions?: string[]
  hasRequiredPermissions?: () => boolean
  preferredMode?: ContextPanelMode
  retention?: ContextPanelRetention
  requiresChatScope?: boolean
  getBadge?: (resource: ContextResource) => number | undefined
  renderer: ComponentType<ContextPanelRenderProps>
  onFirstActivate?: (resource: ContextResource) => void | Promise<void>
  onRestore?: (resource: ContextResource) => void
  pluginId?: string
}

export function getContextResourceKey(resource: ContextResource): string {
  switch (resource.kind) {
    case "canvas-document":
      return `canvas:${resource.documentId}`
    case "project-file":
      return `project:${resource.projectId}:${resource.rootId}:${resource.relPath}`
    case "artifact":
      return `artifact:${resource.artifactId}`
    case "workflow":
      return `workflow:${resource.workflowId}`
  }
}

export type SurfaceBinding =
  | { kind: "canvas-document"; documentId: string }
  | { kind: "project-file"; projectId: string; rootId: string; relPath: string }
  | { kind: "artifact"; artifactId: string }
  | { kind: "workflow"; workflowId: string }
