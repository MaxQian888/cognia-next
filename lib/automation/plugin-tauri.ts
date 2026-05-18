/**
 * Thin wrappers around the three Tauri commands the computer-use plugin
 * registers in `plugins/computer-use/rust/src/commands.rs`. The Rust side
 * already owns the permission gate, consent broker, and audit ring — these
 * helpers only marshal arguments and surface errors.
 *
 * Why a dedicated module instead of putting these in
 * `lib/automation/client.ts`: those Tauri commands belong to the plugin
 * (they expect the plugin's `ComputerAction` enum shape, not the
 * platform-agnostic `desktop.*` contract). Keeping them separate avoids
 * sprawl in the core automation client and lets the plugin's renderer
 * executor import one focused surface.
 */

import { transport } from "@/lib/tauri"
import type { CallContext } from "@/lib/automation/client"
import type {
  BashAction,
  BashResult,
  ComputerAction,
  ComputerActionResult,
  TextEditorAction,
  TextEditorResult,
} from "@/lib/automation/anthropic-action-mapper"

/**
 * Invoke the plugin's native Anthropic `computer_20251124` dispatcher.
 * The plugin command runs `with_gate(Surface::ComputerUse)` and translates
 * via `plugins/computer-use/rust/src/translator.rs` before hitting the
 * automation worker.
 *
 * Most callers should prefer `dispatchAnthropicAction` from the action
 * mapper, which goes through the renderer-side `desktop.*` client and
 * pays for cross-platform consistency. This bypass exists for callers
 * that specifically need the plugin's combined invocation contract
 * (e.g., the External Bridge MCP socket envelope on Windows).
 */
export function pluginComputerUseExecute(
  action: ComputerAction,
  ctx?: CallContext
): Promise<ComputerActionResult> {
  return transport.call<ComputerActionResult>("plugin_computer_use_execute", {
    action,
    ctx,
  })
}

/**
 * Invoke the plugin's Anthropic `bash_20250124` dispatcher.
 */
export function pluginComputerUseBash(action: BashAction, ctx?: CallContext): Promise<BashResult> {
  return transport.call<BashResult>("plugin_computer_use_bash", {
    action,
    ctx,
  })
}

/**
 * Invoke the plugin's Anthropic `text_editor_20250728` dispatcher.
 */
export function pluginComputerUseTextEditor(
  action: TextEditorAction,
  ctx?: CallContext
): Promise<TextEditorResult> {
  return transport.call<TextEditorResult>("plugin_computer_use_text_editor", {
    action,
    ctx,
  })
}
