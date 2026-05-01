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

export const SERVER_NAME = "a2ui-bridge"
export const SERVER_VERSION = "0.9.0"

const SURFACE_TYPES = ["inline", "dialog", "panel", "fullscreen"]

const componentSchema = z
  .object({
    id: z.string(),
    component: z.string(),
  })
  .passthrough()
  .describe("A2UI component definition. See A2UI v0.9 component catalog.")

const widgetSchema = z
  .object({
    hostStrategy: z
      .enum(["native", "artifact-preview", "sandboxed-html", "lazy-runtime"])
      .optional(),
    sizing: z.enum(["auto", "content-height", "fixed-height"]).optional(),
    theme: z.enum(["inherit", "light", "dark"]).optional(),
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
 * @returns {ReturnType<typeof createSdkMcpServer>}
 */
export function buildA2UIBridgeServer({ sessionId, emit }) {
  const dispatch = (message) => {
    emit({ type: "a2ui_dispatch", sessionId, message })
  }

  const tools = [
    tool(
      "a2ui_create_surface",
      "Create a new A2UI surface where the agent can render interactive UI. Reuse the same surfaceId on subsequent updates.",
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
          dispatch({
            type: "createSurface",
            surfaceId: args.surfaceId,
            surfaceType: args.surfaceType,
            catalogId: args.catalogId,
            title: args.title,
            widget: args.widget,
          })
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
      "Replace the components tree on an existing A2UI surface. Components must follow the A2UI v0.9 schema (each has `id` and `component`).",
      {
        surfaceId: z.string(),
        components: z.array(componentSchema).min(1),
      },
      async (args) => {
        try {
          dispatch({
            type: "updateComponents",
            surfaceId: args.surfaceId,
            components: args.components,
          })
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
      "Patch (or replace) the surface's data model — form values, chart data, table rows, etc.",
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
          dispatch({
            type: "dataModelUpdate",
            surfaceId: args.surfaceId,
            data: args.data,
            merge: args.merge ?? true,
          })
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
      "Remove an A2UI surface and free its resources.",
      {
        surfaceId: z.string(),
      },
      async (args) => {
        try {
          dispatch({
            type: "deleteSurface",
            surfaceId: args.surfaceId,
          })
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
  ]

  return createSdkMcpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools,
  })
}

export const A2UI_TOOL_NAMES = [
  "a2ui_create_surface",
  "a2ui_update_components",
  "a2ui_data_model_update",
  "a2ui_delete_surface",
]

export function namespacedA2UIToolNames() {
  return A2UI_TOOL_NAMES.map((n) => `mcp__${SERVER_NAME}__${n}`)
}
