/**
 * Type contracts for plugin-contributed message-part renderers.
 *
 * The host already maintains a full renderer registry in
 * `lib/plugin/api/message-part-renderers.ts` — the gap addressed here is
 * exposing it on the plugin context (`ctx.renderer.registerMessagePart`)
 * and via the manifest (`manifest.messageRenderers[]`).
 *
 * Granularity is intentionally **per-part**, not per-message. Plugins
 * register a React component keyed on the `part.type` string carried inside
 * `UIMessage.parts[]`. The host owns message chrome (select, copy, regen,
 * delete) — plugins only contribute the inner rendering of unknown / custom
 * part types. See ADR-0026 for the rationale.
 *
 * Permission gate: `extension:ui` (via the existing UI extension permission).
 */

import type React from "react"
import type { MessagePartRendererProps } from "@/lib/plugin/api/message-part-renderers"

export type { MessagePartRendererProps } from "@/lib/plugin/api/message-part-renderers"

/**
 * One renderer contribution in `manifest.messageRenderers[]`. Lazy factory
 * shape — `entry` is dynamic-imported only when the host first encounters
 * a message part of the declared `partType`.
 */
export interface PluginMessageRendererDef {
  /**
   * The `part.type` string this renderer claims. Must be unique across all
   * enabled plugins; later registrations replace earlier ones (the registry
   * already records the prior entry so it can be restored on disable).
   */
  partType: string
  /** Relative path inside the plugin install root. */
  entry: string
  /**
   * Named export on the entry module — must resolve to a
   * `React.ComponentType<MessagePartRendererProps>`.
   */
  export: string
  /**
   * Optional human label shown in plugin settings ("Renders Foo blocks").
   */
  label?: string
}

/**
 * Handle returned by `ctx.renderer.registerMessagePart(...)`. Calling
 * `unregister()` is idempotent; the host already unregisters on plugin
 * disable.
 */
export interface PluginMessageRendererRegistration {
  partType: string
  unregister(): void
}

/** Re-exported for ergonomic plugin imports. */
export type PluginMessageRendererComponent = React.ComponentType<MessagePartRendererProps>
