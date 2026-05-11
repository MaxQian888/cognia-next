/**
 * Native Anthropic Tool Registry — dynamic overlay for plugin-contributed
 * first-party Anthropic tools (computer use, bash, text editor).
 *
 * Plugins shipping the `native-anthropic-tool` capability call
 * `registerNativeAnthropicTool` on enable; the plugin manager calls
 * `unregisterNativeAnthropicToolsByPlugin(pluginId)` on disable.
 *
 * This module also exports `computeAnthropicBetaHeaders` — the pure helper
 * the sidecar dispatcher (`sidecar/dispatch/anthropic.mjs`, landing in M5)
 * uses to compose the `Anthropic-Beta` request header from the set of tools
 * a given turn is using.
 *
 * Per-plugin cleanup: `unregisterNativeAnthropicToolsByPlugin(pluginId)`.
 */

import type {
  AnthropicNativeToolType,
  PluginNativeAnthropicToolDef,
} from "@/types/plugin/plugin-native-tool"
import { createOverlayRegistry } from "./createOverlayRegistry"

const registry = createOverlayRegistry<PluginNativeAnthropicToolDef>({
  name: "native-anthropic-tool",
})

/** Register a plugin-contributed native Anthropic tool. */
export const registerNativeAnthropicTool = registry.register
/** Drop a single dynamically-registered tool by id. */
export const unregisterNativeAnthropicToolById = registry.unregisterById
/** Drop every tool contributed by `pluginId`. Returns the number removed. */
export const unregisterNativeAnthropicToolsByPlugin = registry.unregisterByPlugin
/** Get a tool by id. Returns undefined when not registered. */
export const getNativeAnthropicTool = registry.get
/** Get the full registry entry (tool + pluginId tag) for an id. */
export const getNativeAnthropicToolEntry = registry.getEntry
/** List every registered tool id in registration order. */
export const listNativeAnthropicToolIds = registry.list
/** List every registered entry (id + tool + pluginId) in registration order. */
export const listNativeAnthropicToolEntries = registry.entries
/** Test-only: clear every dynamically registered tool. */
export const __resetNativeAnthropicToolsForTesting = registry.__resetForTesting

/**
 * Per-`AnthropicNativeToolType` default `anthropic-beta` header tokens. A
 * plugin can override the default by setting `betaHeader` on its tool def.
 *
 * - `computer_20251124` — still beta as of 2025-11-24; requires the
 *   `computer-use-2025-11-24` header.
 * - `bash_20250124` — GA, no beta header.
 * - `text_editor_20250728` — GA, no beta header.
 *
 * Returning `undefined` here means "no beta header needed for this type".
 */
function defaultBetaHeaderFor(type: AnthropicNativeToolType): string | undefined {
  switch (type) {
    case "computer_20251124":
      return "computer-use-2025-11-24"
    case "bash_20250124":
      return undefined
    case "text_editor_20250728":
      return undefined
  }
}

/**
 * Returns the unique `anthropic-beta` header tokens required by the given
 * native tools. Used by sidecar/dispatch/anthropic.mjs (M5) to compose the
 * Anthropic-Beta request header. Empty array means no beta header needed.
 *
 * Per-type defaults (when a tool's `betaHeader` field is unset):
 *   - "computer_20251124"  → "computer-use-2025-11-24"
 *   - "bash_20250124"      → (no beta — bash is GA)
 *   - "text_editor_20250728" → (no beta — text editor is GA)
 *
 * Plugin-supplied `betaHeader` field overrides the per-type default. The
 * output is deduplicated while preserving first-occurrence order.
 */
export function computeAnthropicBetaHeaders(
  tools: ReadonlyArray<PluginNativeAnthropicToolDef>
): string[] {
  // Set preserves insertion order, which is exactly the "first-occurrence
  // order" semantics callers expect — adding a duplicate is a no-op.
  const seen = new Set<string>()
  for (const tool of tools) {
    const header = tool.betaHeader ?? defaultBetaHeaderFor(tool.type)
    if (header !== undefined) {
      seen.add(header)
    }
  }
  return Array.from(seen)
}
