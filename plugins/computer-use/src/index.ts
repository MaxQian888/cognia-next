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

import type { PluginContext, PluginDefinition, PluginTool } from "@/types/plugin"
import {
  defineNativeAnthropicTool,
  defineSubagent,
  defineAgentTeamTemplate,
} from "@/lib/plugin/sdk"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/chat/slash-command-registry"
// ADR-0026 §5 §D — i18n strings are now declared in `manifest.i18n` below
// and auto-wired by the plugin manager on enable. The old imperative
// `registerPluginI18n` / `unregisterPluginI18n` calls are removed; the
// strings still ship in this file under SLASH_MESSAGES because slash
// handlers run outside React and pick the locale at call time.
import {
  dispatchAnthropicAction,
  type BashAction,
  type ComputerAction,
  type TextEditorAction,
} from "@/lib/automation/anthropic-action-mapper"
import { pluginComputerUseBash, pluginComputerUseTextEditor } from "@/lib/automation/plugin-tauri"
import { getActiveComputerUseSettings } from "@/lib/claude/computer-use-active-settings"
import type { CallContext } from "@/lib/automation/client"

// ADR-0020 W1 audit-fix — build the CallContext for a chat-path
// dispatch. Reads the active character's `requireConsent` setting
// (stashed by `applyComputerUseTools` at chat-send time, keyed by
// session id) and stamps `forceTier: "perCall"` when set. The Rust
// `command_body!` macro then upgrades the gate decision to
// `RequireConsent` so the floating overlay fires. Session id is read
// from a chat-session-aware host helper; we keep this defensive
// because the plugin SDK doesn't (yet) expose session id directly to
// the execute callback.
function buildChatCallContext(): CallContext {
  const sessionId = resolveActiveSessionId()
  const ctx: CallContext = {
    surface: "computerUse",
    pluginId: PLUGIN_ID,
  }
  if (sessionId) {
    const settings = getActiveComputerUseSettings(sessionId)
    if (settings?.requireConsent === true) {
      ctx.forceTier = "perCall"
    }
  }
  return ctx
}

/**
 * Best-effort active session id resolver. The Plugin MCP `execute`
 * callback runs in the renderer at the time the SDK dispatches a
 * tool call. The chat-store keeps the active session id under
 * `useChatStore.getState().sessionId`. Late-imported so this module
 * stays Tauri-runtime-only when the host hasn't booted the chat
 * machinery (e.g. settings-only views).
 */
function resolveActiveSessionId(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@/stores/chat/chat-store") as {
      useChatStore?: { getState: () => { activeSessionId?: string | null } }
    }
    const sid = mod.useChatStore?.getState().activeSessionId
    return typeof sid === "string" && sid.length > 0 ? sid : undefined
  } catch {
    return undefined
  }
}

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

// Tool names the model sees once exposed through the in-process
// `cognia-plugin-tools` MCP server. The sidecar wrapper prefixes them with
// `mcp__cognia-plugin-tools__` before they reach the Anthropic API.
const TOOL_COMPUTER_USE = "computer_use"
const TOOL_BASH = "bash"
const TOOL_TEXT_EDITOR = "text_editor"

// JSON Schema for the `computer_use` plugin tool. Mirrors Anthropic's
// `computer_20251124` input shape: a discriminated union over `action`. We
// keep snake_case names because the model emits them verbatim and the
// Rust enum uses serde's snake_case rename.
const COMPUTER_USE_SCHEMA = {
  type: "object",
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: [
        "screenshot",
        "left_click",
        "right_click",
        "middle_click",
        "double_click",
        "triple_click",
        "mouse_move",
        "left_click_drag",
        "left_mouse_down",
        "left_mouse_up",
        "scroll",
        "type",
        "key",
        "hold_key",
        "wait",
        "cursor_position",
      ],
    },
    coordinate: {
      type: "array",
      items: { type: "integer" },
      minItems: 2,
      maxItems: 2,
      description: "[x, y] screen coordinates in pixels.",
    },
    start_coordinate: {
      type: "array",
      items: { type: "integer" },
      minItems: 2,
      maxItems: 2,
      description: "Drag origin in pixels (left_click_drag only).",
    },
    text: {
      type: "string",
      description: "Text to type or key chord to send.",
    },
    duration: {
      type: "number",
      description: "Seconds (fractional allowed). Used by `hold_key` and `wait`.",
    },
    scroll_direction: {
      type: "string",
      enum: ["up", "down", "left", "right"],
    },
    scroll_amount: {
      type: "integer",
      minimum: 1,
      description: "Wheel notches to scroll (1 amount = 120 OS wheel units).",
    },
  },
} as const

const BASH_SCHEMA = {
  type: "object",
  required: ["command"],
  properties: {
    command: { type: "string", description: "Shell command to execute." },
    restart: {
      type: "boolean",
      description: "If true, restart the bash shell instead of executing a command.",
    },
    timeout: {
      type: "integer",
      minimum: 1,
      description: "Optional timeout in seconds.",
    },
  },
} as const

const TEXT_EDITOR_SCHEMA = {
  type: "object",
  required: ["action", "path"],
  properties: {
    action: {
      type: "string",
      enum: ["view", "create", "str_replace", "insert", "undo_edit"],
    },
    path: { type: "string", description: "Absolute file path." },
    file_text: { type: "string", description: "Used by `create`." },
    old_str: { type: "string", description: "Used by `str_replace`." },
    new_str: { type: "string", description: "Used by `str_replace` and `insert`." },
    insert_line: {
      type: "integer",
      minimum: 0,
      description: "Used by `insert` — line number after which to insert.",
    },
  },
} as const

const COMPUTER_USE_DESCRIPTION =
  "Drive the desktop: take a screenshot; click, double-click, triple-click, drag, " +
  "or scroll at screen coordinates; press a key chord; hold a key; pause; or read " +
  "the cursor position. Use action='screenshot' first to see what's on screen, then " +
  "issue follow-up actions to interact with it. Coordinates are absolute pixels."

const BASH_DESCRIPTION =
  "Execute a bash command on the local machine and return stdout/stderr/exit-code. " +
  "Use `restart: true` to reset the shell state."

const TEXT_EDITOR_DESCRIPTION =
  "View / create / str_replace / insert / undo_edit on a local file. `view` returns " +
  "the file's full text; `create` writes new content; `str_replace` replaces an " +
  "exact unique substring; `insert` appends `new_str` after `insert_line`; " +
  "`undo_edit` reverts the most recent mutating action against `path`."

function buildPluginTools(): PluginTool[] {
  return [
    {
      name: TOOL_COMPUTER_USE,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_COMPUTER_USE,
        description: COMPUTER_USE_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: COMPUTER_USE_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args) => {
        // Surface stays "computerUse" — chat-driven invocations route
        // through the Anthropic native tool semantics. The Rust permission
        // gate uses this to pick the right tier. ADR-0020 W1 audit-fix —
        // `buildChatCallContext` adds `forceTier: "perCall"` when the
        // active character's `requireConsent` is on.
        return dispatchAnthropicAction(args as unknown as ComputerAction, buildChatCallContext())
      },
    },
    {
      name: TOOL_BASH,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_BASH,
        description: BASH_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: BASH_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args) => {
        return pluginComputerUseBash(args as unknown as BashAction, buildChatCallContext())
      },
    },
    {
      name: TOOL_TEXT_EDITOR,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_TEXT_EDITOR,
        description: TEXT_EDITOR_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: TEXT_EDITOR_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args) => {
        return pluginComputerUseTextEditor(
          args as unknown as TextEditorAction,
          buildChatCallContext()
        )
      },
    },
  ]
}

const PLUGIN_TOOL_NAMES = [TOOL_COMPUTER_USE, TOOL_BASH, TOOL_TEXT_EDITOR] as const

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

// ADR-0032 demo — desktop-automation subagents + a team template wiring them
// to the native computer-use tools. Surfaced in the Agent Team picker; both
// subagents are namespaced `cognia-computer-use:<id>` at runtime.
const SCREEN_WATCHER = defineSubagent({
  id: "screen-watcher",
  name: "Screen Watcher",
  description: "Passive observer — summarises on-screen UI state, never acts.",
  prompt:
    "You watch the user's screen via the computer + screenshot tools and surface observations only — never click or type. Summarise visible UI state with timestamps.",
  tools: ["computer", "screenshot"],
  disallowedTools: ["bash", "text_editor"],
  model: "sonnet",
  effort: "medium",
})

const GUI_DRIVER = defineSubagent({
  id: "gui-driver",
  name: "GUI Driver",
  description: "Carries out UI instructions via the computer tool, re-checking after each action.",
  prompt:
    "Carry out the planner's UI instructions via the computer tool. Always re-screenshot after each action and stop on any unexpected dialog.",
  tools: ["computer", "screenshot", "bash"],
  model: "sonnet",
  effort: "high",
})

const DESKTOP_AUTOMATION_TEMPLATE = defineAgentTeamTemplate({
  id: "desktop-automation",
  name: "Desktop Automation",
  description: "A screen-watcher observes while a GUI driver executes UI steps.",
  category: "development",
  icon: "monitor",
  teammates: [
    {
      name: "Screen Watcher",
      description: "Observes UI state.",
      systemPrompt: SCREEN_WATCHER.prompt,
      // Read-only role: replace the native-tool set to drop bash/text_editor.
      capabilities: { nativeAnthropicToolIds: { replace: ["computer", "screenshot"] } },
      tags: ["observe"],
      iconKey: "eye",
    },
    {
      name: "GUI Driver",
      description: "Executes UI actions.",
      systemPrompt: GUI_DRIVER.prompt,
      capabilities: { subagentIds: { add: [`${PLUGIN_ID}:gui-driver`] } },
      tags: ["act"],
      iconKey: "mouse-pointer-click",
    },
  ],
  taskTemplates: [
    {
      title: "Identify the target UI",
      description: "Locate the form/controls.",
      priority: "high",
      assignedToIndex: 0,
    },
    {
      title: "Fill required fields",
      description: "Drive the UI.",
      priority: "high",
      assignedToIndex: 1,
    },
    {
      title: "Verify the result",
      description: "Confirm submission.",
      priority: "normal",
      assignedToIndex: 0,
    },
  ],
  requires: {
    subagentIds: [`${PLUGIN_ID}:screen-watcher`, `${PLUGIN_ID}:gui-driver`],
    nativeAnthropicToolIds: ["computer", "screenshot", "bash"],
  },
})

const definition: PluginDefinition = {
  manifest: {
    id: PLUGIN_ID,
    name: "Computer Use",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["native-anthropic-tool", "commands", "subagent", "agent-team-template"],
    main: "src/index.ts",
    nativeAnthropicTools: [COMPUTER_TOOL, BASH_TOOL, TEXT_EDITOR_TOOL],
    subagents: [SCREEN_WATCHER, GUI_DRIVER],
    agentTeamTemplates: [DESKTOP_AUTOMATION_TEMPLATE],
    permissions: ["native:input", "native:screen"],
    // ADR-0026 §5 §D — declarative i18n. The plugin manager merges these
    // into the host next-intl bundle under `plugin.cognia-computer-use.*`
    // on enable and removes them on disable.
    i18n: {
      locales: {
        en: {
          "slash.cu.description": SLASH_MESSAGES.en.description,
          "slash.cu.body": SLASH_MESSAGES.en.body,
        },
        "zh-CN": {
          "slash.cu.description": SLASH_MESSAGES["zh-CN"].description,
          "slash.cu.body": SLASH_MESSAGES["zh-CN"].body,
        },
      },
    },
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("computer-use plugin activated")

    // Native tool defs are registered declaratively via
    // `manifest.nativeAnthropicTools`. The plugin manager handles
    // register-on-enable and unregister-on-disable through
    // `lib/plugin/core/manager.ts` + `lib/plugin/registries/native-anthropic-tool-registry.ts`.
    // Re-registering here would create harmless duplicate diagnostics; the
    // registry is idempotent by tuple but the duplicate obscures intent.
    //
    // Likewise, i18n is now wired via `manifest.i18n` above; no imperative
    // `registerPluginI18n(...)` call here. See ADR-0026 §5 §D.

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

    // Register the three plugin MCP tools so the chat-side Claude Code SDK
    // sees `mcp__cognia-plugin-tools__{computer_use,bash,text_editor}`.
    // The sidecar's plugin-tools bridge (sidecar/builtin-tools/plugin-tools.mjs)
    // synthesizes the MCP server from `SendOptions.pluginTools`, which is
    // populated by `buildPluginToolsManifest()` from the plugin store.
    if (ctx.agent?.registerTool) {
      for (const tool of buildPluginTools()) {
        ctx.agent.registerTool(tool)
      }
    } else {
      ctx.logger?.warn(
        "ctx.agent.registerTool unavailable — computer-use chat path will not surface tools"
      )
    }
  },
  deactivate: async (ctx?: PluginContext) => {
    if (ctx?.pluginId) {
      unregisterCommandsByPlugin(ctx.pluginId)
      // i18n teardown handled by the manager when manifest.i18n is in use
      // (ADR-0026 §5 §D). No imperative unregisterPluginI18n call needed.
      if (ctx.agent?.unregisterTool) {
        for (const name of PLUGIN_TOOL_NAMES) {
          ctx.agent.unregisterTool(name)
        }
      }
    }
  },
}

export default definition
