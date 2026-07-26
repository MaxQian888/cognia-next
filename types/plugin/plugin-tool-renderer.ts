/**
 * Type contracts for plugin-contributed tool-result renderers.
 *
 * Companion to `plugin-message-renderer.ts`. That one covers custom
 * `UIMessage.parts[].type` values; this one covers TOOL parts, which the host
 * claims wholesale (`tool-*` and `dynamic-tool` are reserved part types routed
 * through the host's own tool renderer). Without this contract a plugin could
 * ship an MCP tool but never render its result as anything richer than the
 * generic content-blocks card.
 *
 * Granularity is per-tool: a plugin registers a React card keyed on the bare
 * tool name it provides. The host owns the tool chrome (header, status, timing,
 * collapse, per-call action slot) — plugins contribute only the result body.
 *
 * Permission gate: `extension:ui` (the shared UI extension permission).
 */

import type React from "react"
import type { ToolResultRendererProps } from "@/lib/plugin/api/tool-result-renderers"

export type { ToolResultRendererProps } from "@/lib/plugin/api/tool-result-renderers"

/**
 * One renderer contribution in `manifest.toolRenderers[]`. Lazy factory shape —
 * `entry` is dynamic-imported only when the plugin is enabled.
 */
export interface PluginToolRendererDef {
  /**
   * Bare tool name this card claims (`my_tool`, not
   * `mcp__cognia-plugin-tools__my_tool` — the host folds the namespaced form
   * onto the bare one so a single registration covers every provider path).
   *
   * Names the host already ships a built-in card for (`Read`, `Grep`,
   * `WebSearch`, …) are never reached: the host table is consulted first.
   */
  toolName: string
  /** Relative path inside the plugin install root. */
  entry: string
  /**
   * Named export on the entry module — must resolve to a
   * `React.ComponentType<ToolResultRendererProps>`.
   */
  export: string
  /** Optional human label shown in plugin settings ("Renders My Tool results"). */
  label?: string
}

/**
 * Handle returned by the imperative registration. `unregister()` is idempotent;
 * the host already unregisters on plugin disable.
 */
export interface PluginToolRendererRegistration {
  toolName: string
  unregister(): void
}

/** Re-exported for ergonomic plugin imports. */
export type PluginToolRendererComponent = React.ComponentType<ToolResultRendererProps>
