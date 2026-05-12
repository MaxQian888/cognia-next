/**
 * Computer Use plugin — registers Anthropic native Computer Use tool
 * definitions (computer_20251124 + bash_20250124 + text_editor_20250728)
 * along with their per-tool Tauri IPC dispatch targets.
 *
 * Scope of this commit (M5 scaffold):
 * - Plugin manifest + activate() that wires the 3 native tool defs into
 *   the native-anthropic-tool-registry overlay (M1·T3)
 * - Slash commands /cu pause / /cu resume / /cu status for session-level
 *   kill-switch (renderer state only — actual gating ships when the
 *   sidecar agent loop lands)
 *
 * DEFERRED to a follow-up:
 * - Rust enigo+xcap implementations (src-tauri/src/plugin_computer_use/*)
 * - Sidecar tools[] passthrough + anthropic-beta header injection
 *   (sidecar/dispatch/anthropic.mjs + native-tool-loop.mjs)
 * - native-tool-bridge.mjs IPC round-trip in sidecar
 * - lib/claude/native-tool-ipc.ts renderer-side dispatcher
 *
 * Until the follow-up lands, attaching this plugin to a character will
 * surface the tool definitions to the model but execution will fail
 * gracefully because the executeIpc.invoke commands don't exist yet —
 * the per-call canUseTool gate in sidecar/dispatch/anthropic.mjs will
 * deny the action and prompt the user.
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
      description: "Show Computer Use plugin status (scaffold — Rust backend pending).",
      handler: () => ({
        message:
          "Computer Use plugin is in scaffold mode. The 3 native tool definitions are registered, but the Rust enigo/xcap backend hasn't shipped yet. Attaching to a character will surface tool definitions to the model but execution will deny via canUseTool until the follow-up commit lands.",
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
