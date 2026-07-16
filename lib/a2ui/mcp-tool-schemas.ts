// JSON-schema-like definitions of the four A2UI bridge tools and helpers
// that build the canonical `McpServer` row used to project the bridge to
// external agents (Claude Code CLI, Cursor, Codex, Gemini, …).
//
// Two consumers:
//
// 1. `lib/db/seed.ts` → upserts the builtin `a2ui-bridge` row at v13 upgrade.
// 2. `sidecar/a2ui-mcp.mjs` (Phase E) → reads these schemas to advertise the
//    same tools over a stand-alone stdio transport.

import type { AgentId, McpServer } from "@cognia/agent-config-types"

export const A2UI_BRIDGE_SERVER_ID = "builtin:a2ui-bridge"
export const A2UI_BRIDGE_SERVER_NAME = "a2ui-bridge"
export const A2UI_BRIDGE_VERSION = "0.9.0"

/** Path placeholder resolved by `lib/claude/agents/*` adapters at projection. */
export const SIDECAR_DIR_PLACEHOLDER = "${COGNIA_SIDECAR_DIR}"

export interface A2UIToolSchema {
  name: string
  description: string
  /** Plain-JSON-Schema object suitable for MCP `tools/list` responses. */
  inputSchema: Record<string, unknown>
}

const componentSchema = {
  type: "object",
  required: ["id", "component"],
  properties: {
    id: { type: "string" },
    component: { type: "string" },
  },
  additionalProperties: true,
} as const

const widgetSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    hostStrategy: {
      type: "string",
      enum: ["native", "artifact-preview", "sandboxed-html", "lazy-runtime"],
    },
    sizing: { type: "string", enum: ["auto", "content-height", "fixed-height"] },
    theme: { type: "string", enum: ["inherit", "light", "dark"] },
    showChrome: { type: "boolean" },
    fallbackText: { type: "string" },
    minHeight: { type: "number" },
  },
} as const

export const A2UI_BRIDGE_TOOLS: readonly A2UIToolSchema[] = [
  {
    name: "a2ui_create_surface",
    description:
      "Create a new A2UI surface where the agent can render interactive UI. Reuse the same surfaceId on subsequent updates.",
    inputSchema: {
      type: "object",
      required: ["surfaceId", "surfaceType"],
      properties: {
        surfaceId: { type: "string", description: "Unique id; reuse to update." },
        surfaceType: {
          type: "string",
          enum: ["inline", "dialog", "panel", "fullscreen"],
        },
        catalogId: { type: "string" },
        title: { type: "string" },
        widget: widgetSchema,
      },
      additionalProperties: false,
    },
  },
  {
    name: "a2ui_update_components",
    description:
      "Replace the components tree on an existing surface. Components must follow the A2UI v0.9 schema.",
    inputSchema: {
      type: "object",
      required: ["surfaceId", "components"],
      properties: {
        surfaceId: { type: "string" },
        components: {
          type: "array",
          minItems: 1,
          items: componentSchema,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "a2ui_data_model_update",
    description:
      "Patch (or replace) the surface's data model — form values, chart data, table rows, etc.",
    inputSchema: {
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
  },
  {
    name: "a2ui_delete_surface",
    description: "Remove an A2UI surface and free its resources.",
    inputSchema: {
      type: "object",
      required: ["surfaceId"],
      properties: { surfaceId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "a2ui_handle_connector_action",
    description:
      "Inject a user action that arrived from an IM channel (Slack block_actions, Lark interactive card, Telegram callback_query, Discord component interaction) onto the matching A2UI surface. The agent receives this as a userAction event on the next turn — identical to in-renderer interactions — so the same flow handles both browser-side and IM-side users.",
    inputSchema: {
      type: "object",
      required: ["surfaceId", "actionType"],
      properties: {
        surfaceId: { type: "string", description: "Target A2UI surface." },
        componentId: {
          type: "string",
          description:
            "Component id inside the surface that fired the action. Optional when the action is surface-level (dismiss).",
        },
        actionType: {
          type: "string",
          enum: ["button", "select", "checkbox", "input", "submit", "dismiss", "platform_specific"],
        },
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
          enum: ["telegram", "discord", "slack", "lark", "onebot"],
          description:
            "Source IM platform — used for audit + per-platform UX touches in the renderer.",
        },
        triggerId: {
          type: "string",
          description:
            "Adapter-supplied unique id for the callback. Used for ack/response routing.",
        },
        conversationKey: {
          type: "string",
          description: "Bus conversationKey the callback originated from.",
        },
      },
      additionalProperties: false,
    },
  },
] as const

/**
 * Default `appsEnabled` map — turn the bridge on for every external agent
 * cognia-next can write to. Read-only agents (cline, roo-code) are listed
 * but left as `false` so the projection sync skips them.
 */
export function defaultA2UIAppsEnabled(): Partial<Record<AgentId, boolean>> {
  return {
    "claude-code": true,
    "claude-desktop": true,
    cursor: true,
    vscode: true,
    codex: true,
    gemini: true,
    windsurf: true,
    zed: true,
    kiro: true,
    opencode: true,
    cline: false,
    "roo-code": false,
  }
}

/**
 * Build the canonical builtin `McpServer` row inserted at Dexie schema v13.
 *
 * The row is `enabled: false` for in-app projection — the in-process server
 * registered by `sidecar/claude-host.mjs` already handles the SDK path, so
 * surfacing the same server twice would only confuse `mcp__a2ui-bridge__*`
 * tool counts. The `appsEnabled` map drives external-agent injection only.
 */
export function buildA2UIBridgeMcpRow(now: number = Date.now()): McpServer {
  return {
    id: A2UI_BRIDGE_SERVER_ID,
    name: A2UI_BRIDGE_SERVER_NAME,
    transport: "stdio",
    config: {
      command: "node",
      args: [`${SIDECAR_DIR_PLACEHOLDER}/a2ui-mcp.mjs`],
      env: {},
    },
    enabled: false,
    appsEnabled: defaultA2UIAppsEnabled(),
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Predicate for "this is the builtin a2ui-bridge row" used by seed,
 * settings UI, and backup migration to keep the row immutable-by-name.
 */
export function isA2UIBridgeRow(row: { name?: string; id?: string } | null): boolean {
  if (!row) return false
  return row.id === A2UI_BRIDGE_SERVER_ID || row.name === A2UI_BRIDGE_SERVER_NAME
}

/**
 * Namespaced tool name as Claude Agent SDK exposes them
 * (`mcp__<server>__<tool>`).  Useful for `Character.allowedTools` and
 * the build-options injection.
 */
export function namespacedA2UIToolNames(): string[] {
  return A2UI_BRIDGE_TOOLS.map((t) => `mcp__${A2UI_BRIDGE_SERVER_NAME}__${t.name}`)
}
