/**
 * The plugin contract's share of `lib/plugin/api/message-part-api.ts`, which re-exports these.
 */
import type React from "react"
import type { MessagePartRendererProps } from "./message-part-renderers"

export interface PluginMessagePartAPI {
  /**
   * Register a renderer for a custom `part.type`. Returns an unregister
   * callback. The plugin host also calls `clearMessagePartRenderersForPlugin`
   * on plugin disable, so manual cleanup is a belt-and-braces step rather
   * than a hard requirement.
   *
   * Constraint — `type` cannot start with `tool-`, `text`, `reasoning`,
   * `file`, or be `dynamic-tool`, `a2ui`, `subagent`, `agent-team-dispatch`,
   * `artifact`, `sources`, or `canvas` (those are owned by the host). The
   * function returns a noop unregister for invalid types and logs a warning.
   */
  registerPartRenderer: (
    type: string,
    component: React.ComponentType<MessagePartRendererProps>
  ) => () => void
}
