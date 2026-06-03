// In-process A2UI bridge MCP server.
//
// Exposes the four A2UI protocol primitives as MCP tools so Claude Agent SDK
// sessions can paint interactive surfaces without writing fenced ```a2ui```
// blocks. Each tool dispatches an `a2ui_dispatch` event back to Tauri (which
// forwards to the renderer), then returns ok:true to the SDK.
//
// External agents (Claude Code CLI, Cursor, Codex, …) talk to this same set
// of tools through a separate stdio bridge — see `sidecar/a2ui-mcp.mjs`.

import { z } from "zod"
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import { toolText, toolError } from "../builtin-tools/safety.mjs"
import {
  SERVER_NAME as DEFS_SERVER_NAME,
  SERVER_VERSION as DEFS_SERVER_VERSION,
  SURFACE_TYPES,
  WIDGET_HOST_STRATEGIES,
  WIDGET_SIZING,
  WIDGET_THEMES,
  CONNECTOR_ACTION_TYPES,
  CONNECTOR_PLATFORMS,
  TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  buildDispatch,
} from "./tool-defs.mjs"

// Names, descriptions, enums, and the args→dispatch mapping come from the
// shared tool-defs module so this SDK server and the stand-alone stdio server
// (sidecar/a2ui-mcp.mjs) cannot drift. Only the Zod *shapes* are local —
// the SDK's tool() requires a ZodRawShape, which can't be shared with the
// raw-JSON-Schema stdio transport.
export const SERVER_NAME = DEFS_SERVER_NAME
export const SERVER_VERSION = DEFS_SERVER_VERSION

const componentSchema = z
  .object({
    id: z.string(),
    component: z.string(),
  })
  .passthrough()
  .describe("A2UI component definition. See A2UI v0.9 component catalog.")

const widgetSchema = z
  .object({
    hostStrategy: z.enum(WIDGET_HOST_STRATEGIES).optional(),
    sizing: z.enum(WIDGET_SIZING).optional(),
    theme: z.enum(WIDGET_THEMES).optional(),
    showChrome: z.boolean().optional(),
    fallbackText: z.string().optional(),
    minHeight: z.number().optional(),
  })
  .passthrough()

/**
 * Build the in-process A2UI bridge MCP server.
 *
 * @param {object} options
 * @param {string} options.sessionId  Session id used to scope dispatches.
 * @param {(payload: unknown) => void} options.emit  sidecar->parent stdout writer.
 * @param {boolean} [options.alwaysLoad]
 *        When true (the default for this server — interactive A2UI surfaces
 *        must never be deferred behind tool search), the four bridge tools
 *        stay resident in the prompt. Mirrors
 *        `createSdkMcpServer({ alwaysLoad })`.
 * @returns {ReturnType<typeof createSdkMcpServer>}
 */
export function buildA2UIBridgeServer({ sessionId, emit, alwaysLoad = true }) {
  const dispatch = (message) => {
    emit({ type: "a2ui_dispatch", sessionId, message })
  }

  const tools = [
    tool(
      "a2ui_create_surface",
      TOOL_DESCRIPTIONS.a2ui_create_surface,
      {
        surfaceId: z.string().describe("Unique id for this surface; reuse to update."),
        surfaceType: z
          .enum(SURFACE_TYPES)
          .describe("Surface container kind: inline | dialog | panel | fullscreen."),
        catalogId: z.string().optional(),
        title: z.string().optional(),
        widget: widgetSchema.optional(),
      },
      async (args) => {
        try {
          dispatch(buildDispatch("a2ui_create_surface", args))
          return toolText({
            ok: true,
            surfaceId: args.surfaceId,
            dispatched: true,
          })
        } catch (err) {
          return toolError(err, "a2ui_create_surface")
        }
      }
    ),

    tool(
      "a2ui_update_components",
      TOOL_DESCRIPTIONS.a2ui_update_components,
      {
        surfaceId: z.string(),
        components: z.array(componentSchema).min(1),
      },
      async (args) => {
        try {
          dispatch(buildDispatch("a2ui_update_components", args))
          return toolText({
            ok: true,
            surfaceId: args.surfaceId,
            count: args.components.length,
            dispatched: true,
          })
        } catch (err) {
          return toolError(err, "a2ui_update_components")
        }
      }
    ),

    tool(
      "a2ui_data_model_update",
      TOOL_DESCRIPTIONS.a2ui_data_model_update,
      {
        surfaceId: z.string(),
        data: z.record(z.unknown()),
        merge: z
          .boolean()
          .optional()
          .describe("Default true: merge into existing model. false: replace."),
      },
      async (args) => {
        try {
          dispatch(buildDispatch("a2ui_data_model_update", args))
          return toolText({
            ok: true,
            surfaceId: args.surfaceId,
            keys: Object.keys(args.data),
            merged: args.merge ?? true,
          })
        } catch (err) {
          return toolError(err, "a2ui_data_model_update")
        }
      }
    ),

    tool(
      "a2ui_delete_surface",
      TOOL_DESCRIPTIONS.a2ui_delete_surface,
      {
        surfaceId: z.string(),
      },
      async (args) => {
        try {
          dispatch(buildDispatch("a2ui_delete_surface", args))
          return toolText({
            ok: true,
            surfaceId: args.surfaceId,
            dispatched: true,
          })
        } catch (err) {
          return toolError(err, "a2ui_delete_surface")
        }
      }
    ),

    tool(
      "a2ui_handle_connector_action",
      TOOL_DESCRIPTIONS.a2ui_handle_connector_action,
      {
        surfaceId: z.string().describe("Target A2UI surface."),
        componentId: z
          .string()
          .optional()
          .describe(
            "Component id inside the surface that fired the action. Optional when the action is surface-level (dismiss)."
          ),
        actionType: z.enum(CONNECTOR_ACTION_TYPES),
        value: z
          .string()
          .optional()
          .describe(
            "Primary scalar value: button action id, selected option key, checkbox boolean string, edited text."
          ),
        payload: z
          .record(z.unknown())
          .optional()
          .describe(
            "Structured payload for multi-value actions (form submissions, platform_specific events)."
          ),
        platform: z.enum(CONNECTOR_PLATFORMS).optional(),
        triggerId: z.string().optional(),
        conversationKey: z.string().optional(),
      },
      async (args) => {
        try {
          dispatch(buildDispatch("a2ui_handle_connector_action", args))
          return toolText({
            ok: true,
            surfaceId: args.surfaceId,
            actionType: args.actionType,
            dispatched: true,
          })
        } catch (err) {
          return toolError(err, "a2ui_handle_connector_action")
        }
      }
    ),
  ]

  return createSdkMcpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools,
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
  })
}

export const A2UI_TOOL_NAMES = TOOL_NAMES

export function namespacedA2UIToolNames() {
  return A2UI_TOOL_NAMES.map((n) => `mcp__${SERVER_NAME}__${n}`)
}
