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
import type {
  ActionRequest,
  AppLocator,
  ElementHandle,
  GetAppStateOptions,
  Locator,
  UiStateRevision,
} from "@cognia/plugin-sdk"
import type {
  ModelContentBlock,
  MouseButton,
  Rect,
  ZoomedRegion,
} from "@cognia/plugin-sdk/api/automation"
import {
  actionRequestSchema,
  appLocatorSchema,
  elementHandleSchema,
  frameToModelContent,
  getAppStateOptionsSchema,
  locatorSchema,
  toToolSchema,
} from "@cognia/plugin-sdk/api/automation"
import manifestJson from "../plugin.json"

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
const TOOL_ZOOM = "zoom"
const TOOL_WAIT = "wait"
const TOOL_FIND_TEXT = "find_text"
const TOOL_CLICK_TEXT = "click_text"

// Model-facing JSON Schemas for the canonical app-session contract.
//
// Rendered from the zod definitions in `lib/automation/action-schemas` rather
// than hand-written, because the hand-written ones had degenerated into
// `{type:"object"}` for every interesting payload: the eight `UiAction` kinds,
// the element-vs-pixel target union and the `strategy` switch existed only as
// TypeScript types, so the model was never told they were there. A bare
// `{type:"object"}` is also erased to `z.unknown()` by the sidecar's
// `jsonSchemaToZodShape`, so nothing validated the call either.
const GET_APP_STATE_SCHEMA = {
  type: "object",
  required: ["sessionId", "locator"],
  properties: {
    sessionId: {
      type: "string",
      description:
        "Your identifier for this app session. Reuse the same value across a task so " +
        "revisions and element handles stay comparable.",
    },
    locator: toToolSchema(appLocatorSchema),
    options: toToolSchema(getAppStateOptionsSchema),
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
    revision: {
      type: "integer",
      minimum: 1,
      description: "The revision returned by the most recent get_app_state.",
    },
    locator: toToolSchema(locatorSchema),
    limit: { type: "integer", minimum: 1, maximum: 1000 },
  },
} as const

const EXPAND_ELEMENT_SCHEMA = {
  type: "object",
  required: ["handle"],
  properties: {
    handle: toToolSchema(elementHandleSchema),
    continuationToken: { type: ["string", "null"] },
    limit: { type: "integer", minimum: 1, maximum: 250 },
  },
} as const

const PERFORM_ACTION_SCHEMA = {
  type: "object",
  required: ["request"],
  properties: {
    request: toToolSchema(actionRequestSchema),
  },
} as const

const ZOOM_SCHEMA = {
  type: "object",
  required: ["sessionId", "lineageId", "revision", "region"],
  properties: {
    sessionId: { type: "string" },
    lineageId: { type: "string" },
    revision: { type: "integer", minimum: 1 },
    region: {
      type: "object",
      required: ["x", "y", "width", "height"],
      description:
        "Region to magnify, in the screenshot's own pixel space (top-left origin). " +
        "Clamped to the frame.",
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
      },
    },
  },
} as const

const WAIT_SCHEMA = {
  type: "object",
  required: ["durationMs"],
  properties: {
    durationMs: {
      type: "integer",
      minimum: 50,
      maximum: 10000,
      description: "How long to pause, in milliseconds. Clamped to 50–10000.",
    },
  },
} as const

const FIND_TEXT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Text to locate, matched case-insensitively with whitespace collapsed. " +
        "Omit to list every text block found.",
    },
    languages: { type: "array", items: { type: "string" } },
  },
} as const

const CLICK_TEXT_SCHEMA = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string" },
    occurrence: {
      type: "integer",
      minimum: 1,
      description: "Which match to click when several match (1-based, default 1).",
    },
    button: { type: "string", enum: ["left", "right", "middle"] },
    doubleClick: { type: "boolean" },
    languages: { type: "array", items: { type: "string" } },
  },
} as const

const ZOOM_DESCRIPTION =
  "Magnify one region of the current revision's screenshot. Use this when a control is too " +
  "small to identify or click accurately in the full frame. The crop is taken from the frame " +
  "as captured, so it carries real detail rather than a magnified blur. The result reports " +
  "`region` (where the crop sits, in the coordinate space of the screenshot you were shown) " +
  "and `scale` (crop pixels per region pixel). Map a point back with " +
  "`x = region.x + zoomX / scale` and `y = region.y + zoomY / scale`. When `scale` is 1 that " +
  "is just adding the origin."

const WAIT_DESCRIPTION =
  "Pause before the next call, to let the UI settle after an action that animates or loads."

const FIND_TEXT_DESCRIPTION =
  "Locate on-screen text by OCR and get its screen coordinates. Use when the accessibility " +
  "tree has no node for what you can see — canvas, games, remote desktop, custom-drawn " +
  "controls. Captures the primary monitor, not the app window."

const CLICK_TEXT_DESCRIPTION =
  "Locate on-screen text by OCR and click it. Same fallback role as find_text: reach for it " +
  "only when query_elements cannot see the target."

const GET_APP_STATE_DESCRIPTION =
  "Read a fresh app-bound AX tree revision and matching screenshot. Returns the screenshot " +
  "as an image alongside the JSON revision. This must be called before every action and " +
  "again immediately after every action — the returned turnToken is single-use."

const LIST_APPS_DESCRIPTION =
  "List running applications that can be selected for a Computer Use session."

const QUERY_ELEMENTS_DESCRIPTION =
  "Query the canonical AX tree for the current revision without taking another screenshot."

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
  "target is a web page you control; prefer app-session Computer Use for native apps. " +
  "Within Computer Use, target elements by handle rather than pixels wherever query_elements can " +
  "find them — handles survive layout shifts and are delivered through the accessibility API. " +
  "When a control is too small to identify confidently, zoom into that region and read it again " +
  "rather than guessing a coordinate. When the accessibility tree has no node for something you " +
  "can plainly see — canvas, games, remote desktop, custom-drawn controls — fall back to " +
  "find_text / click_text, which locate text by OCR on the primary monitor rather than within " +
  "the app window. Use wait after an action that animates or loads, then re-read state."

/**
 * Split a `UiStateRevision` into an MCP tool result whose screenshot is a real
 * image block.
 *
 * Returning the revision object directly meant the sidecar fell through to
 * `toolText` and `JSON.stringify`-ed the whole thing — so the base64 PNG
 * reached the model as a single enormous text block. A vision model cannot
 * read that: it was simultaneously blind to the screen and paying six figures
 * of tokens for the privilege. `isCallToolResult` in the sidecar's
 * plugin-tools bridge passes a properly shaped result through untouched.
 *
 * The dimensions stay in the JSON even though the bytes move out, because a
 * `pixel` action target has to restate the frame it was measured against —
 * that restatement is the stale-frame guard.
 */
function appStateToolResult(revision: UiStateRevision): { content: ModelContentBlock[] } {
  return { content: frameToModelContent(revision).content }
}

/** Bounds for `wait`, so a model cannot park the turn indefinitely. */
const WAIT_MIN_MS = 50
const WAIT_MAX_MS = 10_000

/**
 * A zoom is only useful if the model also learns where the crop sits: without
 * the origin it would report coordinates in crop space and the click would land
 * somewhere else entirely.
 */
function zoomToolResult(zoomed: ZoomedRegion): { content: ModelContentBlock[] } {
  return { content: frameToModelContent(zoomed).content }
}

function buildPluginTools(
  automation: Pick<
    PluginContext["automation"],
    | "getAppState"
    | "listApps"
    | "queryElements"
    | "expandElement"
    | "performAction"
    | "zoom"
    | "findText"
    | "clickText"
  >
): PluginTool[] {
  const origin = (context: { sessionId?: string; messageId?: string }) => ({
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.messageId ? { messageId: context.messageId } : {}),
  })
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
        const revision = await automation.getAppState(
          input.sessionId,
          input.locator,
          input.options,
          origin(context)
        )
        return appStateToolResult(revision)
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
        return automation.listApps(origin(context))
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
        return automation.queryElements(
          {
            sessionId: input.sessionId,
            lineageId: input.lineageId,
            revision: input.revision,
          },
          input.locator,
          input.limit,
          origin(context)
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
        return automation.expandElement(
          input.handle,
          input.continuationToken,
          input.limit,
          origin(context)
        )
      },
    },
    {
      name: TOOL_ZOOM,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_ZOOM,
        description: ZOOM_DESCRIPTION,
        category: "automation",
        requiresApproval: true,
        parametersSchema: ZOOM_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args, context) => {
        const input = args as unknown as {
          sessionId: string
          lineageId: string
          revision: number
          region: Rect
        }
        const zoomed = await automation.zoom(
          {
            sessionId: input.sessionId,
            lineageId: input.lineageId,
            revision: input.revision,
          },
          input.region,
          origin(context)
        )
        return zoomToolResult(zoomed)
      },
    },
    {
      name: TOOL_WAIT,
      pluginId: PLUGIN_ID,
      definition: {
        name: TOOL_WAIT,
        description: WAIT_DESCRIPTION,
        category: "automation",
        // Waiting drives nothing and reveals nothing; asking the operator to
        // approve a sleep would train them to click through prompts.
        requiresApproval: false,
        parametersSchema: WAIT_SCHEMA as unknown as Record<string, unknown>,
      },
      execute: async (args) => {
        const requested = Number((args as { durationMs?: unknown }).durationMs ?? 0)
        const durationMs = Number.isFinite(requested)
          ? Math.min(Math.max(Math.round(requested), WAIT_MIN_MS), WAIT_MAX_MS)
          : WAIT_MIN_MS
        await new Promise((resolve) => setTimeout(resolve, durationMs))
        return { waitedMs: durationMs }
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
        const input = args as unknown as { query?: string; languages?: string[] }
        return automation.findText(input, origin(context))
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
        const input = args as unknown as {
          query: string
          occurrence?: number
          button?: MouseButton
          doubleClick?: boolean
          languages?: string[]
        }
        return automation.clickText(input, origin(context))
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
        return automation.performAction(input.request, origin(context))
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
  TOOL_ZOOM,
  TOOL_WAIT,
  TOOL_FIND_TEXT,
  TOOL_CLICK_TEXT,
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
    // i18n is wired via `manifest.i18n` above; no imperative
    // `registerPluginI18n(...)` call here. See ADR-0026 §5 §D.

    const locale = pluginLocale()
    const copy = SLASH_MESSAGES[locale] ?? SLASH_MESSAGES.en

    // Register the app-session tools for the chat-side plugin MCP bridge.
    // The sidecar's plugin-tools bridge (sidecar/builtin-tools/plugin-tools.mjs)
    // synthesizes the MCP server from `SendOptions.pluginTools`, which is
    // populated by `buildPluginToolsManifest()` from the plugin store.
    if (ctx.agent?.registerTool) {
      for (const tool of buildPluginTools(ctx.automation)) {
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
