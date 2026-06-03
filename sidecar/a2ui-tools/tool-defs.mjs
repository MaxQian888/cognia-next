// Single source of truth for the A2UI bridge tool contract on the *sidecar*
// side. Both MCP server implementations import from here:
//
//   - sidecar/a2ui-tools/index.mjs  → in-process Agent SDK server (Zod shapes)
//   - sidecar/a2ui-mcp.mjs          → stand-alone stdio server (raw JSON Schema)
//
// Keeping the names, descriptions, enums, raw JSON schemas, and the
// args→dispatch mappers in ONE place ends the three-way drift that previously
// existed between these two files and the renderer-side canonical schema
// (lib/a2ui/mcp-tool-schemas.ts). A Jest parity test cross-checks this module
// against that canonical TS source so the copies can never silently diverge.
//
// This module is intentionally dependency-free (no @anthropic-ai/claude-agent-sdk,
// no zod) so it can be imported from a Jest test as plain ESM.

export const SERVER_NAME = "a2ui-bridge"
export const SERVER_VERSION = "0.9.0"

// ---- Enums (mirror types/a2ui/schema.ts + types/connectors/interaction.ts) ----

export const SURFACE_TYPES = ["inline", "dialog", "panel", "fullscreen"]
export const WIDGET_HOST_STRATEGIES = [
  "native",
  "artifact-preview",
  "sandboxed-html",
  "lazy-runtime",
]
export const WIDGET_SIZING = ["auto", "content-height", "fixed-height"]
export const WIDGET_THEMES = ["inherit", "light", "dark"]
export const CONNECTOR_ACTION_TYPES = [
  "button",
  "select",
  "checkbox",
  "input",
  "submit",
  "dismiss",
  "platform_specific",
]
export const CONNECTOR_PLATFORMS = ["telegram", "discord", "slack", "lark", "onebot"]

// ---- Tool names + descriptions ------------------------------------------------

export const TOOL_NAMES = [
  "a2ui_create_surface",
  "a2ui_update_components",
  "a2ui_data_model_update",
  "a2ui_delete_surface",
  "a2ui_handle_connector_action",
]

export const TOOL_DESCRIPTIONS = {
  a2ui_create_surface:
    "Create a new A2UI surface where the agent can render interactive UI. Reuse the same surfaceId on subsequent updates.",
  a2ui_update_components:
    "Replace the components tree on an existing surface. Components must follow the A2UI v0.9 schema.",
  a2ui_data_model_update:
    "Patch (or replace) the surface's data model — form values, chart data, table rows, etc.",
  a2ui_delete_surface: "Remove an A2UI surface and free its resources.",
  a2ui_handle_connector_action:
    "Inject a user action that arrived from an IM channel (Slack block_actions, Lark interactive card, Telegram callback_query, Discord component interaction) onto the matching A2UI surface. The agent receives this as a userAction event on the next turn — identical to in-renderer interactions — so the same flow handles both browser-side and IM-side users.",
}

// ---- Raw JSON Schemas (consumed by the stand-alone stdio server) --------------

const componentSchema = {
  type: "object",
  required: ["id", "component"],
  properties: {
    id: { type: "string" },
    component: { type: "string" },
  },
  additionalProperties: true,
}

const widgetSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    hostStrategy: { type: "string", enum: WIDGET_HOST_STRATEGIES },
    sizing: { type: "string", enum: WIDGET_SIZING },
    theme: { type: "string", enum: WIDGET_THEMES },
    showChrome: { type: "boolean" },
    fallbackText: { type: "string" },
    minHeight: { type: "number" },
  },
}

export const RAW_INPUT_SCHEMAS = {
  a2ui_create_surface: {
    type: "object",
    required: ["surfaceId", "surfaceType"],
    properties: {
      surfaceId: { type: "string", description: "Unique id; reuse to update." },
      surfaceType: { type: "string", enum: SURFACE_TYPES },
      catalogId: { type: "string" },
      title: { type: "string" },
      widget: widgetSchema,
    },
    additionalProperties: false,
  },
  a2ui_update_components: {
    type: "object",
    required: ["surfaceId", "components"],
    properties: {
      surfaceId: { type: "string" },
      components: { type: "array", minItems: 1, items: componentSchema },
    },
    additionalProperties: false,
  },
  a2ui_data_model_update: {
    type: "object",
    required: ["surfaceId", "data"],
    properties: {
      surfaceId: { type: "string" },
      data: { type: "object", additionalProperties: true },
      merge: {
        type: "boolean",
        description: "Default true: merge into existing model. false: replace.",
      },
    },
    additionalProperties: false,
  },
  a2ui_delete_surface: {
    type: "object",
    required: ["surfaceId"],
    properties: { surfaceId: { type: "string" } },
    additionalProperties: false,
  },
  a2ui_handle_connector_action: {
    type: "object",
    required: ["surfaceId", "actionType"],
    properties: {
      surfaceId: { type: "string", description: "Target A2UI surface." },
      componentId: {
        type: "string",
        description:
          "Component id inside the surface that fired the action. Optional when the action is surface-level (dismiss).",
      },
      actionType: { type: "string", enum: CONNECTOR_ACTION_TYPES },
      value: {
        type: "string",
        description:
          "Primary scalar value: button action id, selected option key, checkbox boolean string, edited text.",
      },
      payload: {
        type: "object",
        additionalProperties: true,
        description:
          "Structured payload for multi-value actions (form submissions, platform_specific events).",
      },
      platform: {
        type: "string",
        enum: CONNECTOR_PLATFORMS,
        description:
          "Source IM platform — used for audit + per-platform UX touches in the renderer.",
      },
      triggerId: {
        type: "string",
        description: "Adapter-supplied unique id for the callback. Used for ack/response routing.",
      },
      conversationKey: {
        type: "string",
        description: "Bus conversationKey the callback originated from.",
      },
    },
    additionalProperties: false,
  },
}

/**
 * Build the `tools/list` array for the stand-alone stdio server.
 * @returns {Array<{name:string, description:string, inputSchema:object}>}
 */
export function rawTools() {
  return TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: RAW_INPUT_SCHEMAS[name],
  }))
}

// ---- Args → a2ui dispatch message --------------------------------------------

/**
 * Map a tool call's arguments to the `a2ui` protocol message that gets wrapped
 * in an `a2ui_dispatch` envelope and forwarded to the renderer store.
 *
 * @param {string} name  one of TOOL_NAMES
 * @param {Record<string, unknown>} args
 * @returns {Record<string, unknown> | null} dispatch message, or null if unknown tool
 */
export function buildDispatch(name, args) {
  switch (name) {
    case "a2ui_create_surface":
      return {
        type: "createSurface",
        surfaceId: args.surfaceId,
        surfaceType: args.surfaceType,
        catalogId: args.catalogId,
        title: args.title,
        widget: args.widget,
      }
    case "a2ui_update_components":
      return {
        type: "updateComponents",
        surfaceId: args.surfaceId,
        components: args.components,
      }
    case "a2ui_data_model_update":
      return {
        type: "dataModelUpdate",
        surfaceId: args.surfaceId,
        data: args.data,
        merge: args.merge ?? true,
      }
    case "a2ui_delete_surface":
      return {
        type: "deleteSurface",
        surfaceId: args.surfaceId,
      }
    case "a2ui_handle_connector_action":
      return {
        type: "connectorAction",
        surfaceId: args.surfaceId,
        componentId: args.componentId,
        actionType: args.actionType,
        value: args.value,
        payload: args.payload,
        platform: args.platform,
        triggerId: args.triggerId,
        conversationKey: args.conversationKey,
      }
    default:
      return null
  }
}

export function namespacedA2UIToolNames() {
  return TOOL_NAMES.map((n) => `mcp__${SERVER_NAME}__${n}`)
}
