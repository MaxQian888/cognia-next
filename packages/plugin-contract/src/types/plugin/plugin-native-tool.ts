/**
 * Plugin Native Anthropic Tool Definitions
 *
 * Plugins contributing the `native-anthropic-tool` capability wrap one of
 * Anthropic's first-party tool schemas (computer_20251124, bash_20250124,
 * text_editor_20250728) and own the Tauri command that executes the tool
 * server-side. The sidecar dispatches by `executeIpc.invoke` rather than
 * hardcoding command strings — plugins keep full control of their Rust
 * surface.
 */

export type AnthropicNativeToolType = "computer_20251124" | "bash_20250124" | "text_editor_20250728"

export type NativeToolPermissionPolicy = "always-ask" | "session-allow" | "preauth"

export interface PluginNativeAnthropicToolDef {
  /** Unique id within the plugin. */
  id: string
  /** Display name (what the model sees as the tool name). */
  name: string
  /** Which Anthropic schema this tool follows. */
  type: AnthropicNativeToolType
  /**
   * anthropic-beta header token this tool requires. Optional — when omitted,
   * computeAnthropicBetaHeaders() falls back to a per-type default.
   */
  betaHeader?: string
  /** computer_20251124 / displayWidthPx. */
  displayWidthPx?: number
  /** computer_20251124 / displayHeightPx. */
  displayHeightPx?: number
  /** computer_20251124 / displayNumber (X11). */
  displayNumber?: number
  /** computer_20251124 / enable_zoom. */
  enableZoom?: boolean
  /**
   * The Tauri command the sidecar should call to execute this tool. The
   * plugin owns the Rust command name; sidecar dispatch never hardcodes
   * specific command strings.
   */
  executeIpc: { invoke: string }
  /**
   * Per-call gating policy:
   * - "always-ask":    every invocation must be approved through canUseTool
   * - "session-allow": first call asks; subsequent calls in the same session pass
   * - "preauth":       no per-call approval (only enable for trusted plugins)
   * Defaults to "always-ask".
   */
  permissionPolicy?: NativeToolPermissionPolicy
}
