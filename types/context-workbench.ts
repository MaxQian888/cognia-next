import type { ComponentType } from "react"

export type ContextWorkbenchMode = "collapsed" | "narrow" | "wide" | "focus"
export type ContextWorkbenchPlacement = "adjacent-editor" | "chat-dock" | "mobile-sheet"
export type ContextPanelRetention = "stateful" | "ephemeral"
export type ContextPanelMode = Exclude<ContextWorkbenchMode, "collapsed">
/**
 * What a resource affords, resolved per resource in
 * `lib/context-workbench/capabilities.ts`.
 *
 * **This is a plugin-facing extension point in its entirety.** Capabilities are
 * consumed only through a panel's `requiredCapabilities`, and no first-party
 * panel declares that field — the built-in panels gate themselves with
 * `appliesTo` predicates instead, which can express things a capability set
 * cannot (e.g. "this artifact, in this session"). So a capability having no
 * first-party consumer is the norm here, not evidence of drift, and none of
 * these should be deleted for looking unused.
 *
 * What *would* be drift is a capability that `resolveContextCapabilities` never
 * produces: a plugin could declare it and its panel would then never appear for
 * any resource. `lib/context-workbench/taxonomy-parity.test.ts` pins that.
 */
export type ContextCapability =
  | "ai"
  | "comments"
  | "inspect"
  | "review"
  | "preview"
  /** Resource can execute (canvas / runnable artifact / workflow). */
  | "run"
  /** Resource has reusable templates (workflow). */
  | "templates"
  | "workspace"
  /**
   * Resource has a version history. Note the built-in panel that once sat here
   * was renamed to `artifacts` under the `review` activity — it lists every
   * artifact in scope rather than a version timeline — so nothing first-party
   * corresponds to this capability by name.
   */
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
 *
 * Unlike `ContextCapability` above, activities ARE consumed first-party — every
 * built-in panel declares one. `templates` is the single exception; see
 * `INTENTIONALLY_UNCONSUMED_CONTEXT_ACTIVITIES`.
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

/**
 * Activities no first-party panel registers into — rail groups reserved for
 * plugins. `templates` is claimed by the in-tree `prompt-templates` plugin,
 * which registers imperatively via `ctx.contextPanels.register()` rather than
 * declaring a manifest panel, so it does not read as a first-party consumer.
 *
 * Same contract as the capability list above: the taxonomy gate test rejects an
 * activity that is neither consumed nor listed here.
 */
export const INTENTIONALLY_UNCONSUMED_CONTEXT_ACTIVITIES = [
  "templates",
] as const satisfies readonly CanonicalContextActivity[]

export type CanonicalContextActivity = (typeof CANONICAL_CONTEXT_ACTIVITIES)[number]
export type ContextActivity = CanonicalContextActivity | (string & {})

/**
 * Top-to-bottom order of the activity rail.
 *
 * Explicit because the rail used to inherit its order from each group's
 * lowest-ordered panel, which made one `order` number mean two things: where an
 * activity sits in the rail, AND where a panel sits inside its group. Ordering
 * the artifact AI panel ahead of the proposal review therefore also dragged the
 * whole `ai` group above `preview-run` — the primary surface ended up third in
 * the rail behind a chat panel. `order` now governs the group alone.
 *
 * Activities missing from this list (every plugin-contributed one) sort after
 * the named entries, in first-seen order, so a third-party panel can never fall
 * off the rail.
 */
export const CONTEXT_ACTIVITY_RAIL_ORDER: readonly ContextActivity[] = [
  "preview-run",
  "review",
  "ai",
  "comments",
  "inspect",
  "workspace",
  "templates",
]

/** Rail position of an activity; unknown activities sort to the end. */
export function contextActivityRailIndex(activity: ContextActivity): number {
  const index = CONTEXT_ACTIVITY_RAIL_ORDER.indexOf(activity)
  return index === -1 ? CONTEXT_ACTIVITY_RAIL_ORDER.length : index
}

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
  /**
   * Whose lifetime this panel's *mounted-ness* follows.
   *
   * - `"resource"` (default) — the panel belongs to the resource on screen and
   *   unmounts when the host moves to another one.
   * - `"session"` — the panel's content is session-scoped even though it hangs
   *   off a resource surface (the embedded browser, the project workspace). It
   *   stays mounted while the conversation does.
   *
   * Without this, switching artifact tabs re-keyed the whole layout, the new
   * scope's `activatedPanelIds` did not contain the browser, and the panel was
   * dropped — releasing the process-wide embedded-webview lease and losing the
   * page, the Monaco buffers and the file-tree state. Switching back opened a
   * blank one. Hosts opt in by passing `sessionScopeKey` to `ContextWorkbench`;
   * without it this degrades to `"resource"`.
   */
  scope?: "resource" | "session"
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
