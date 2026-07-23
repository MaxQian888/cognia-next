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
/**
 * The canonical activity groups an activity rail can show.
 *
 * A runtime array rather than a bare union so the plugin manifest validator can
 * check against the same source the SDK types against — the two drifted apart
 * once already, and a value present in the type but missing from the validator
 * passes tsc and then fails at install time.
 *
 * `workspace` is its own activity rather than a member of `inspect`: sharing a
 * rail button with `metadata` (which sorts first) buried the project workspace
 * behind an ℹ️ icon plus a group tab, turning a one-click surface into
 * two-level navigation.
 */
export const CANONICAL_CONTEXT_ACTIVITIES = [
  "ai",
  "comments",
  "inspect",
  "review",
  "preview-run",
  "templates",
  "workspace",
] as const

export type CanonicalContextActivity = (typeof CANONICAL_CONTEXT_ACTIVITIES)[number]
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
  | {
      /**
       * The chat session itself — the dock's fallback resource when no artifact
       * is active. Backs the empty state, the embedded browser and the
       * session-scoped workspace/history panels so the chat right rail keeps a
       * single workbench shell instead of dropping to the legacy dock chrome.
       */
      kind: "session"
      sessionId: string
      /** A session is not a document, so it never carries a selection. */
      selection?: never
      capabilities: ContextCapability[]
    }

export type ContextResourceKind = ContextResource["kind"]

/**
 * The read permission each resource kind is gated on, for both the imperative
 * `ctx.contextPanels.register` path and the manifest validator.
 *
 * One runtime source for the same reason `CANONICAL_CONTEXT_ACTIVITIES` is one
 * — and this pair drifted too: the validator carried a hand-copied literal that
 * was missing `session`, so a manifest declaring the chat dock's *own* fallback
 * resource kind passed tsc and then failed at install with `resourceKinds.invalid`.
 * Typed as an exhaustive `Record` so a new kind is a compile error here rather
 * than a silent gap at a call site.
 */
export const CONTEXT_RESOURCE_READ_PERMISSIONS: Record<ContextResourceKind, string> = {
  "canvas-document": "canvas:read",
  "project-file": "project:read",
  artifact: "artifact:read",
  workflow: "workflow:read",
  session: "session:read",
}

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
  /**
   * The permissions this panel was registered against, kept for diagnostics and
   * plugin-detail display. **Not** the gate — see `hasRequiredPermissions`.
   */
  requiredPermissions?: string[]
  /**
   * The permission gate, injected by whoever registered the panel (which is the
   * only layer holding both the `pluginId` and `permission-api`). Re-evaluated
   * on every `resolve`, so grants and revocations take effect as soon as
   * `permission-api` calls `contextPanelRegistry.refresh()`.
   */
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
    case "session":
      return `session:${resource.sessionId}`
  }
}

export type SurfaceBinding =
  | { kind: "canvas-document"; documentId: string }
  | { kind: "project-file"; projectId: string; rootId: string; relPath: string }
  | { kind: "artifact"; artifactId: string }
  | { kind: "workflow"; workflowId: string }
