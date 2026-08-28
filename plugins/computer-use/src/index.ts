/**
 * Computer Use plugin.
 *
 * This module only publishes model-facing tools over the canonical
 * app-session automation commands. Coordinate transforms, permissions,
 * policy, capture, actions, and verification all remain in
 * `cognia-automation`.
 */

import type { PluginContext, PluginDefinition, PluginTool } from "@cognia/plugin-sdk"
import { defineSubagent, defineAgentTeamTemplate, defineContextProvider } from "@cognia/plugin-sdk"
// ADR-0026 §5 §D — i18n strings are now declared in `manifest.i18n` below
// and auto-wired by the plugin manager on enable. The old imperative
// `registerPluginI18n` / `unregisterPluginI18n` calls are removed; the
// strings still ship in this file under SLASH_MESSAGES because slash
// handlers run outside React and pick the locale at call time.
import { desktop } from "@cognia/plugin-sdk/api/automation"
import type {
  ActionRequest,
  AppLocator,
  ElementHandle,
  GetAppStateOptions,
  Locator,
} from "@cognia/plugin-sdk"
import { getActiveComputerUseSettings } from "@cognia/plugin-sdk/api/automation"
import { HOST_FALLBACK_RUNTIME_REF, sandboxSessionRuntime } from "@cognia/plugin-sdk/api/sandbox"
import type { CallContext } from "@cognia/plugin-sdk/api/automation"
import manifestJson from "../plugin.json"

// ADR-0020 W1 audit-fix — build the CallContext for a chat-path
// dispatch. Reads the active character's `requireConsent` setting
// (stashed by `applyComputerUseTools` at chat-send time, keyed by
// session id) and stamps `forceTier: "perCall"` when set. The Rust
// `command_body!` macro then upgrades the gate decision to
// `RequireConsent` so the floating overlay fires. The PluginTool execution
// context supplies the originating session; the focused-session lookup is a
// defensive fallback for non-chat callers that omit it.
async function buildChatCallContext(
  originSessionId?: string,
  originMessageId?: string,
  sandboxRuntimeRef?: string
): Promise<CallContext> {
  // The invocation context is authoritative in split/concurrent chat. Focus
  // can move while a background session's tool call is still executing.
  const sessionId = originSessionId ?? resolveActiveSessionId()
  const ctx: CallContext = {
    surface: "computerUse",
    pluginId: PLUGIN_ID,
  }
  if (sessionId) {
    // Scope consent grants and automation state to the originating chat.
    ctx.sessionKey = sessionId
    const settings = getActiveComputerUseSettings(sessionId)
    if (settings?.requireConsent === true) {
      ctx.forceTier = "perCall"
    }
  }
  if (originMessageId) {
    ctx.turnKey = originMessageId
  }
  // A chat send carries its resolved placement. When the envelope field did not
  // survive the hop, recover the ORIGIN session's binding — deliberately not
  // the focused-session fallback above, which is fine for scoping consent but
  // would borrow another conversation's placement here. Without the recovery a
  // dropped ref answers a session bound to a remote target by driving the
  // operator's own desktop.
  //
  // Callers with no session at all — workflow nodes, plan steps, External
  // Bridge orchestration, plugin-to-plugin calls — keep the host/local
  // placement, which is exactly where they ran before the runtime ref existed.
  const placementRef =
    sandboxRuntimeRef ??
    sandboxSessionRuntime.activeRefForSession(originSessionId) ??
    HOST_FALLBACK_RUNTIME_REF
  return sandboxSessionRuntime.decorateComputerUseContext(placementRef, ctx)
}

/**
 * Best-effort active session id resolver. The Plugin MCP `execute` callback
 * runs in the renderer when the SDK dispatches a tool call and is handed no
 * context, so `ctx.sessions` is captured at activation instead. Absent (before
 * activate, or on a host with no chat machinery booted) reads as "no session",
 * which is what every caller already treats it as.
 */
let sessions: PluginContext["sessions"] | undefined

function resolveActiveSessionId(): string | undefined {
  const sid = sessions?.getCurrentSessionId()
  return typeof sid === "string" && sid.length > 0 ? sid : undefined
}

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
const TOOL_GET_APP_STATE = "get_app_state"
const TOOL_LIST_APPS = "list_apps"
const TOOL_QUERY_ELEMENTS = "query_elements"
const TOOL_EXPAND_ELEMENT = "expand_element"
const TOOL_PERFORM_ACTION = "perform_action"

// Model-facing JSON Schemas for the canonical app-session contract.
const GET_APP_STATE_SCHEMA = {
  type: "object",
  required: ["sessionId", "locator"],
  properties: {
    sessionId: { type: "string" },
    locator: {
      type: "object",
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["bundleId", "path", "displayName"] },
        bundleId: { type: "string" },
        path: { type: "string" },
        displayName: { type: "string" },
      },
    },
    options: { type: "object" },
  },
} as const

const LIST_APPS_SCHEMA = {
  type: "object",
  properties: {},
} as const

const QUERY_ELEMENTS_SCHEMA = {
  type: "object",
  required: ["sessionId", "lineageId", "revision", "locator"],
  properties: {
    sessionId: { type: "string" },
    lineageId: { type: "string" },
    revision: { type: "integer", minimum: 1 },
    locator: { type: "object" },
    limit: { type: "integer", minimum: 1, maximum: 1000 },
  },
} as const

const GET_APP_STATE_DESCRIPTION =
  "Read a fresh app-bound AX tree revision and matching screenshot. This must be called " +
  "before every action and again immediately after every action."

const LIST_APPS_DESCRIPTION =
  "List running applications that can be selected for a Computer Use session."

const QUERY_ELEMENTS_DESCRIPTION =
  "Query the canonical AX tree for the current revision without taking another screenshot."

const EXPAND_ELEMENT_SCHEMA = {
  type: "object",
  required: ["handle"],
  properties: {
    handle: { type: "object" },
    continuationToken: { type: ["string", "null"] },
    limit: { type: "integer", minimum: 1, maximum: 250 },
  },
} as const

const PERFORM_ACTION_SCHEMA = {
  type: "object",
  required: ["request"],
  properties: {
    request: { type: "object" },
  },
} as const

const EXPAND_ELEMENT_DESCRIPTION =
  "Expand one element from the current canonical AX revision with an opaque continuation token."

const PERFORM_ACTION_DESCRIPTION =
  "Perform one revision-bound semantic, pixel, or auto action. The turn token is single-use."

// Comparative guidance so the model picks the right automation surface for a
// task — the computer-use plugin previously shipped no ambient context.
const SURFACE_GUIDANCE =
  "Automation surfaces — pick by target: (1) get_app_state/query_elements/expand_element/" +
  "perform_action → native desktop apps with revision-bound AX and screenshot state. " +
  "(2) browser_* tools → the in-app preview webview, best for " +
  "localhost / your own dev server (DOM-accurate: snapshot refs, click/type/press_key, evaluate). " +
  "(3) mcp__playwright__* → arbitrary PUBLIC websites (headless, reliable cross-origin). (4) web_fetch / " +
  "web_search → read-only page content, no interaction. Prefer DOM (browser_*) over pixels when the " +
  "target is a web page you control; prefer app-session Computer Use for native apps."

function buildPluginTools(): PluginTool[] {
  return [
    {
      name: TOOL_GET_APP_STATE,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_GET_APP_STATE,
        description: GET_APP_STATE_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: GET_APP_STATE_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args, context) => {
        const input = args as unknown as {
          sessionId: string
          locator: AppLocator
          options?: GetAppStateOptions
        }
        return desktop.getAppState(
          input.sessionId,
          input.locator,
          input.options,
          await buildChatCallContext(
            context.sessionId,
            context.messageId,
            context.sandboxRuntimeRef
          )
        )
      },
    },
    {
      name: TOOL_LIST_APPS,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_LIST_APPS,
        description: LIST_APPS_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: LIST_APPS_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (_args, context) => {
        return desktop.listApps(
          await buildChatCallContext(
            context.sessionId,
            context.messageId,
            context.sandboxRuntimeRef
          )
        )
      },
    },
    {
      name: TOOL_QUERY_ELEMENTS,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_QUERY_ELEMENTS,
        description: QUERY_ELEMENTS_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: QUERY_ELEMENTS_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args, context) => {
        const input = args as unknown as {
          sessionId: string
          lineageId: string
          revision: number
          locator: Locator
          limit?: number
        }
        return desktop.queryElements(
          {
            sessionId: input.sessionId,
            lineageId: input.lineageId,
            revision: input.revision,
          },
          input.locator,
          input.limit,
          await buildChatCallContext(
            context.sessionId,
            context.messageId,
            context.sandboxRuntimeRef
          )
        )
      },
    },
    {
      name: TOOL_EXPAND_ELEMENT,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_EXPAND_ELEMENT,
        description: EXPAND_ELEMENT_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: EXPAND_ELEMENT_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args, context) => {
        const input = args as unknown as {
          handle: ElementHandle
          continuationToken?: string | null
          limit?: number
        }
        return desktop.expandElement(
          input.handle,
          input.continuationToken,
          input.limit,
          await buildChatCallContext(
            context.sessionId,
            context.messageId,
            context.sandboxRuntimeRef
          )
        )
      },
    },
    {
      name: TOOL_PERFORM_ACTION,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_PERFORM_ACTION,
        description: PERFORM_ACTION_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: PERFORM_ACTION_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args, context) => {
        const input = args as unknown as { request: ActionRequest }
        return desktop.performAction(
          input.request,
          await buildChatCallContext(
            context.sessionId,
            context.messageId,
            context.sandboxRuntimeRef
          )
        )
      },
    },
  ]
}

const PLUGIN_TOOL_NAMES = [
  TOOL_GET_APP_STATE,
  TOOL_LIST_APPS,
  TOOL_QUERY_ELEMENTS,
  TOOL_EXPAND_ELEMENT,
  TOOL_PERFORM_ACTION,
] as const

const SLASH_MESSAGES: Record<string, { description: string; body: string }> = {
  en: {
    description: "Show Computer Use plugin status.",
    body: "Computer Use is active with app-scoped state, deep AX queries, and revision-bound actions. Characters with `enableComputerUse: true` receive these tools on every send. Tier and consent live under Settings → Automation.",
  },
  "zh-CN": {
    description: "显示 Computer Use 插件状态。",
    body: "Computer Use 已启用应用级状态、深层 AX 查询和修订绑定动作。启用了 `enableComputerUse: true` 的角色将在每次发送时获得这些工具。等级与授权见“设置 → 自动化”。",
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
    "Read native app state through get_app_state and query_elements. Surface observations only; never call perform_action. Summarise visible UI state with revision numbers.",
  tools: ["get_app_state", "list_apps", "query_elements", "expand_element"],
  disallowedTools: ["perform_action"],
  model: "sonnet",
  effort: "medium",
})

const GUI_DRIVER = defineSubagent({
  id: "gui-driver",
  name: "GUI Driver",
  description: "Carries out UI instructions via the computer tool, re-checking after each action.",
  prompt:
    "Carry out UI instructions through app-session Computer Use. Call get_app_state before every perform_action and immediately after it; stop on any unexpected dialog.",
  tools: ["get_app_state", "list_apps", "query_elements", "expand_element", "perform_action"],
  model: "sonnet",
  effort: "high",
})

const DESKTOP_AUTOMATION_TEMPLATE = defineAgentTeamTemplate({
  id: "desktop-automation",
  name: "Desktop Automation",
  description: "A screen-watcher observes while a GUI driver executes UI steps.",
  category: "development",
  icon: "Monitor",
  teammates: [
    {
      name: "Screen Watcher",
      description: "Observes UI state.",
      systemPrompt: SCREEN_WATCHER.prompt,
      // Read-only role: replace the native-tool set to drop bash/text_editor.
      capabilities: { nativeAnthropicToolIds: { replace: [] } },
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
    nativeAnthropicToolIds: [],
  },
})

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here WINS and would silently drop `commands[]`.
  manifest: {
    ...(manifestJson as object),
    nativeAnthropicTools: [],
    subagents: [SCREEN_WATCHER, GUI_DRIVER],
    agentTeamTemplates: [DESKTOP_AUTOMATION_TEMPLATE],
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
    sessions = ctx.sessions

    // i18n is wired via `manifest.i18n` above; no imperative
    // `registerPluginI18n(...)` call here. See ADR-0026 §5 §D.

    const locale = pluginLocale()
    const copy = SLASH_MESSAGES[locale] ?? SLASH_MESSAGES.en

    // Register the app-session tools for the chat-side plugin MCP bridge.
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
    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration and teardown.
    return {
      onCommand: async (command: string) => {
        if (command !== "cu") return false
        ctx.ui?.showToast?.(copy.body, "info")
        return true
      },
    }
  },
  deactivate: async (ctx?: PluginContext) => {
    if (ctx?.pluginId) {
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
