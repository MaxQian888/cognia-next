/**
 * Computer Use plugin — registers Anthropic native Computer Use tool
 * definitions (computer_20251124 + bash_20250124 + text_editor_20250728)
 * along with their per-tool Tauri IPC dispatch targets.
 *
 * What ships now (ADR-0020):
 * - Plugin manifest + activate() registers the 3 native tool defs into
 *   the native-anthropic-tool-registry overlay.
 * - Rust automation backend (`src-tauri/src/automation/`) implements all
 *   10 actions required by `computer_20251124` via UIA Pattern-first +
 *   `windows::SendInput` fallback. macOS / Linux ship a minimum-viable
 *   subset (screenshot / click / type / keys).
 * - Permission gate routes `PerCall` driving calls through the
 *   `ConsentBroker`. The renderer-side `<ConsentOverlay />` listens for
 *   `automation:consent-request` and resolves the broker channel.
 * - build-options.ts attaches the tools + `anthropic-beta` header on
 *   every send when `character.enableComputerUse === true`.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { defineNativeAnthropicTool } from "@/lib/plugin/sdk"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/chat/slash-command-registry"

const COMPUTER_TOOL = defineNativeAnthropicTool({
  id: "computer",
  name: "computer",
  type: "computer_20251124",
  displayWidthPx: 1280,
  displayHeightPx: 800,
  enableZoom: true,
  executeIpc: { invoke: "plugin_computer_use_execute" },
  permissionPolicy: "always-ask",
})

const BASH_TOOL = defineNativeAnthropicTool({
  id: "bash",
  name: "bash",
  type: "bash_20250124",
  executeIpc: { invoke: "plugin_computer_use_bash" },
  permissionPolicy: "always-ask",
})

const TEXT_EDITOR_TOOL = defineNativeAnthropicTool({
  id: "text_editor",
  name: "str_replace_based_edit_tool",
  type: "text_editor_20250728",
  executeIpc: { invoke: "plugin_computer_use_text_editor" },
  permissionPolicy: "always-ask",
})

const definition: PluginDefinition = {
  manifest: {
    id: "cognia-computer-use",
    name: "Computer Use",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["native-anthropic-tool", "commands"],
    main: "src/index.ts",
    nativeAnthropicTools: [COMPUTER_TOOL, BASH_TOOL, TEXT_EDITOR_TOOL],
    permissions: ["native:input", "native:screen"],
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("computer-use plugin activated (scaffold — Rust backend pending)")

    ctx.agent?.registerNativeAnthropicTool?.(COMPUTER_TOOL)
    ctx.agent?.registerNativeAnthropicTool?.(BASH_TOOL)
    ctx.agent?.registerNativeAnthropicTool?.(TEXT_EDITOR_TOOL)

    registerSlashCommand({
      id: "cu.status",
      name: "/cu",
      description: "Show Computer Use plugin status.",
      handler: () => ({
        message:
          "Computer Use plugin is active. computer / bash / text_editor are registered as native Anthropic tools. Characters with `enableComputerUse: true` (Settings → Characters → Edit) will receive the tools on every send. Tier + consent live under Settings → Automation.",
      }),
      source: "plugin",
      pluginId: ctx.pluginId,
    })
  },
  deactivate: async (ctx?: PluginContext) => {
    if (ctx?.pluginId) unregisterCommandsByPlugin(ctx.pluginId)
  },
}

export default definition
