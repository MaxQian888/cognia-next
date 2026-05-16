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
import { registerPluginI18n, unregisterPluginI18n } from "@/lib/i18n/plugin-i18n-registry"

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

// Plugin-side i18n. Slash-command handlers run outside the React tree so
// they can't use `useTranslations()` — we ship the strings here and pick the
// active locale from the host bundle at call time. The
// `lib/i18n/plugin-i18n-registry` exposes the bundle to the regular
// `useTranslations()` consumer in case future host UI surfaces want to
// render the same copy.
const PLUGIN_ID = "cognia-computer-use"

const SLASH_MESSAGES: Record<string, { description: string; body: string }> = {
  en: {
    description: "Show Computer Use plugin status.",
    body: "Computer Use plugin is active. computer / bash / text_editor are registered as native Anthropic tools. Characters with `enableComputerUse: true` (Settings → Characters → Edit) will receive the tools on every send. Tier + consent live under Settings → Automation.",
  },
  "zh-CN": {
    description: "显示 Computer Use 插件状态。",
    body: "Computer Use 插件已激活。computer / bash / text_editor 已注册为 Anthropic 原生工具。启用了 `enableComputerUse: true` 的角色（设置 → 角色 → 编辑）将在每次发送时携带这些工具。等级与授权见 设置 → 自动化。",
  },
}

function pluginLocale(): "en" | "zh-CN" {
  if (typeof navigator !== "undefined") {
    const lang = (navigator.language || "en").toLowerCase()
    if (lang.startsWith("zh")) return "zh-CN"
  }
  return "en"
}

const definition: PluginDefinition = {
  manifest: {
    id: PLUGIN_ID,
    name: "Computer Use",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["native-anthropic-tool", "commands"],
    main: "src/index.ts",
    nativeAnthropicTools: [COMPUTER_TOOL, BASH_TOOL, TEXT_EDITOR_TOOL],
    permissions: ["native:input", "native:screen"],
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("computer-use plugin activated")

    // Native tool defs are registered declaratively via
    // `manifest.nativeAnthropicTools`. The plugin manager handles
    // register-on-enable and unregister-on-disable through
    // `lib/plugin/core/manager.ts` + `lib/plugin/registries/native-anthropic-tool-registry.ts`.
    // Re-registering here would create harmless duplicate diagnostics; the
    // registry is idempotent by tuple but the duplicate obscures intent.

    registerPluginI18n({
      pluginId: PLUGIN_ID,
      messages: {
        en: {
          "slash.cu.description": SLASH_MESSAGES.en.description,
          "slash.cu.body": SLASH_MESSAGES.en.body,
        },
        "zh-CN": {
          "slash.cu.description": SLASH_MESSAGES["zh-CN"].description,
          "slash.cu.body": SLASH_MESSAGES["zh-CN"].body,
        },
      },
    })

    const locale = pluginLocale()
    const copy = SLASH_MESSAGES[locale] ?? SLASH_MESSAGES.en

    registerSlashCommand({
      id: "cu.status",
      name: "/cu",
      description: copy.description,
      handler: () => ({ message: copy.body }),
      source: "plugin",
      pluginId: ctx.pluginId,
    })
  },
  deactivate: async (ctx?: PluginContext) => {
    if (ctx?.pluginId) {
      unregisterCommandsByPlugin(ctx.pluginId)
      unregisterPluginI18n(ctx.pluginId)
    }
  },
}

export default definition
