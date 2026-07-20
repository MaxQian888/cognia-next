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
  defineContextProvider,
} from "@cognia/plugin-sdk"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
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
import { clickScreenText, findScreenText } from "@/lib/automation/ocr-click"
import { getActiveComputerUseSettings } from "@/lib/claude/computer-use-active-settings"
import { getActiveComputerUseTarget } from "@/lib/claude/computer-use-target-state"
import { getActiveSandboxConfine } from "@/lib/claude/sandbox-confine-state"
import type { CallContext } from "@/lib/automation/client"

// ADR-0020 W1 audit-fix — build the CallContext for a chat-path
// dispatch. Reads the active character's `requireConsent` setting
// (stashed by `applyComputerUseTools` at chat-send time, keyed by
// session id) and stamps `forceTier: "perCall"` when set. The Rust
// `command_body!` macro then upgrades the gate decision to
// `RequireConsent` so the floating overlay fires. The PluginTool execution
// context supplies the originating session; the focused-session lookup is a
// defensive fallback for non-chat callers that omit it.
function buildChatCallContext(originSessionId?: string): CallContext {
  // The invocation context is authoritative in split/concurrent chat. Focus
  // can move while a background session's tool call is still executing.
  const sessionId = originSessionId ?? resolveActiveSessionId()
  const ctx: CallContext = {
    surface: "computerUse",
    pluginId: PLUGIN_ID,
  }
  if (sessionId) {
    // Keys the per-session model-view state (coordinate scaling, screenshot
    // dedup, failure counters) on both sides: `automation::model_view` for
    // the Rust executeIpc path, the TS action mapper for MCP dispatch.
    ctx.sessionKey = sessionId
    const settings = getActiveComputerUseSettings(sessionId)
    if (settings?.requireConsent === true) {
      ctx.forceTier = "perCall"
    }
    // Screen-off mode: stamp the flag so the Rust plugin command ensures the
    // bundled virtual display is active + primary before driving the action
    // (capture stays non-black with the monitor off). Strict — the command
    // errors with `vdd_unavailable` when the driver isn't installed.
    if (settings?.screenOffMode === true) {
      ctx.screenOffMode = true
    }
    // ADR-0020 remote-target — when this session resolved to a cua sandbox,
    // stamp the connection id so the Rust `cua_route` layer dispatches the
    // action to the container instead of the host.
    const target = getActiveComputerUseTarget(sessionId)
    if (target.kind === "remote") {
      ctx.sandboxConnectionId = target.connectionId
    }
    // ADR-0028 — when the session enabled the sandbox, stamp the confine so the
    // native bash / text_editor run OS-sandboxed / path-confined in Rust.
    const confine = getActiveSandboxConfine(sessionId)
    if (confine) {
      ctx.sandboxConfine = confine
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
const TOOL_FIND_TEXT = "find_text"
const TOOL_CLICK_TEXT = "click_text"

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

const FIND_TEXT_SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "Visible text to locate (case-insensitive). Omit to list every readable block.",
    },
    languages: {
      type: "array",
      items: { type: "string" },
      description: "BCP-47 OCR languages (e.g. en, zh). Defaults to the user's configured set.",
    },
  },
} as const

const CLICK_TEXT_SCHEMA = {
  type: "object",
  required: ["text"],
  properties: {
    text: { type: "string", description: "Visible on-screen label to click." },
    occurrence: {
      type: "integer",
      minimum: 1,
      description: "Which match to click when several blocks match (1-based, default 1).",
    },
    button: { type: "string", enum: ["left", "right", "middle"] },
    double: { type: "boolean", description: "Double-click instead of a single click." },
    languages: { type: "array", items: { type: "string" } },
  },
} as const

const FIND_TEXT_DESCRIPTION =
  "OCR the current screen and return on-screen text blocks with their screen coordinates " +
  "(ranked best-first when `text` is given; otherwise everything readable). Use this to locate " +
  "UI text before clicking, instead of eyeballing a screenshot. Needs an OCR provider that emits " +
  "bounding boxes (e.g. tesseract / windows-ocr)."

const CLICK_TEXT_DESCRIPTION =
  "Find visible text on the screen via OCR and click its center — no pixel-coordinate guessing. " +
  "`text` is the label to click; `occurrence` (1-based) disambiguates repeats; `button`/`double` " +
  "control the click. Returns an error listing the match count when the text isn't found."

// Comparative guidance so the model picks the right automation surface for a
// task — the computer-use plugin previously shipped no ambient context.
const SURFACE_GUIDANCE =
  "Automation surfaces — pick by target: (1) computer_use + find_text/click_text → ANY native " +
  "desktop app or arbitrary screen (pixel + OCR; find_text/click_text resolve on-screen text to a " +
  "coordinate so you don't guess pixels). (2) browser_* tools → the in-app preview webview, best for " +
  "localhost / your own dev server (DOM-accurate: snapshot refs, click/type/press_key, evaluate). " +
  "(3) mcp__playwright__* → arbitrary PUBLIC websites (headless, reliable cross-origin). (4) web_fetch / " +
  "web_search → read-only page content, no interaction. Prefer DOM (browser_*) over pixels when the " +
  "target is a web page you control; prefer computer_use for native apps; prefer Playwright for public sites."

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
      execute: async (args, context) => {
        // Surface stays "computerUse" — chat-driven invocations route
        // through the Anthropic native tool semantics. The Rust permission
        // gate uses this to pick the right tier. ADR-0020 W1 audit-fix —
        // `buildChatCallContext` adds `forceTier: "perCall"` when the
        // active character's `requireConsent` is on.
        return dispatchAnthropicAction(
          args as unknown as ComputerAction,
          buildChatCallContext(context.sessionId)
        )
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
      execute: async (args, context) => {
        return pluginComputerUseBash(
          args as unknown as BashAction,
          buildChatCallContext(context.sessionId)
        )
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
      execute: async (args, context) => {
        return pluginComputerUseTextEditor(
          args as unknown as TextEditorAction,
          buildChatCallContext(context.sessionId)
        )
      },
    },
    {
      name: TOOL_FIND_TEXT,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_FIND_TEXT,
        description: FIND_TEXT_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: FIND_TEXT_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args, context) => {
        const a = (args ?? {}) as { text?: string; languages?: string[] }
        try {
          return await findScreenText({
            query: a.text,
            languages: a.languages,
            ctx: buildChatCallContext(context.sessionId),
          })
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    },
    {
      name: TOOL_CLICK_TEXT,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_CLICK_TEXT,
        description: CLICK_TEXT_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: CLICK_TEXT_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args, context) => {
        const a = (args ?? {}) as {
          text?: string
          occurrence?: number
          button?: "left" | "right" | "middle"
          double?: boolean
          languages?: string[]
        }
        try {
          return await clickScreenText({
            query: String(a.text ?? ""),
            occurrence: a.occurrence,
            button: a.button,
            doubleClick: a.double,
            languages: a.languages,
            ctx: buildChatCallContext(context.sessionId),
          })
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    },
  ]
}

const PLUGIN_TOOL_NAMES = [
  TOOL_COMPUTER_USE,
  TOOL_BASH,
  TOOL_TEXT_EDITOR,
  TOOL_FIND_TEXT,
  TOOL_CLICK_TEXT,
] as const

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
    capabilities: ["native-anthropic-tool", "commands", "tools", "subagent", "agent-team-template"],
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

    // Comparative surface guidance — steers the model to the right tool family
    // (computer_use vs browser_* vs Playwright vs web_fetch). See SURFACE_GUIDANCE.
    ctx.agent?.context?.registerProvider?.(
      defineContextProvider({
        id: "computer-use:surface-guidance",
        name: "Automation surface guidance",
        provide: () => SURFACE_GUIDANCE,
      })
    )
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
