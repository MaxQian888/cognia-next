/**
 * The plugin contract's share of `lib/workflow/nodes/catalog.ts`, which re-exports these.
 */
import type { CapabilityId } from "../../platform/capabilities"
import type { WorkflowNodeCategory, WorkflowNodeKind } from "../../../types/workflow/visual"

export interface NodeCatalogEntry {
  kind: WorkflowNodeKind
  /** Current authoring version for plugin-contributed kinds. */
  typeVersion?: number
  category: WorkflowNodeCategory | "plugin"
  /** Short label shown in the sidebar / palette. */
  label: string
  /** One-line description shown in the search sidebar tooltip + palette. */
  description: string
  /** Lucide icon name (resolved by the renderer). */
  iconName: string
  /** Free-form keywords used by the palette's fuzzy search. */
  keywords: string[]
  /** True if the node should NOT appear in user-facing pickers (e.g., legacy). */
  hidden?: boolean
  /** True if the node only fires on Tauri (web-mode hides them). */
  desktopOnly?: boolean
  /**
   * Platform capabilities the node's executor needs at run time (ADR 0060).
   * Checked by the orchestrator's capability preflight against
   * `detectLocalCapabilities()`; surfaced as an affinity badge in the editor.
   * Absent = runs anywhere the webview runs (unless `desktopOnly` — see
   * {@link effectiveRequires}).
   */
  requires?: readonly CapabilityId[]
  /**
   * Set on plugin-contributed entries; absent for built-ins. Used by the
   * sidebar to render a per-plugin sub-group inside the "Plugin nodes"
   * section.
   */
  pluginId?: string
  /**
   * Optional JSON Schema describing the node's params. Set for plugin
   * entries that ship a `paramsSchema`; used by the inspector to render an
   * auto-generated `SchemaForm` instead of the raw-JSON fallback.
   */
  paramsSchema?: Record<string, unknown>
  /**
   * Params inserted when a node is dropped from the palette. Built-ins use
   * code defaults; plugin entries carry their `PluginNodeDef.defaultParams`
   * or `PluginTriggerDef.defaultParams` here so the editor can preserve the
   * author-provided starter config without knowing plugin internals.
   */
  defaultParams?: Record<string, unknown>
}
