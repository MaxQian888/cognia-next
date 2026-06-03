/**
 * Tests for the canonical a2ui-bridge MCP schemas.
 *
 * The schemas in this file are the contract that external agents
 * (Claude Code CLI, Cursor, Codex, …) see, plus the row seeded into
 * Dexie at v13 upgrade. Any drift here breaks both projections.
 */

import {
  A2UI_BRIDGE_SERVER_ID,
  A2UI_BRIDGE_SERVER_NAME,
  A2UI_BRIDGE_VERSION,
  A2UI_BRIDGE_TOOLS,
  SIDECAR_DIR_PLACEHOLDER,
  buildA2UIBridgeMcpRow,
  defaultA2UIAppsEnabled,
  isA2UIBridgeRow,
  namespacedA2UIToolNames,
} from "./mcp-tool-schemas"
import * as sidecarDefs from "../../sidecar/a2ui-tools/tool-defs.mjs"

describe("a2ui MCP tool schemas", () => {
  describe("constants", () => {
    it("exposes the canonical builtin ids", () => {
      expect(A2UI_BRIDGE_SERVER_ID).toBe("builtin:a2ui-bridge")
      expect(A2UI_BRIDGE_SERVER_NAME).toBe("a2ui-bridge")
      expect(A2UI_BRIDGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
      expect(SIDECAR_DIR_PLACEHOLDER).toBe("${COGNIA_SIDECAR_DIR}")
    })
  })

  describe("A2UI_BRIDGE_TOOLS", () => {
    it("contains the five contracted tools", () => {
      const names = A2UI_BRIDGE_TOOLS.map((t) => t.name)
      expect(names).toEqual([
        "a2ui_create_surface",
        "a2ui_update_components",
        "a2ui_data_model_update",
        "a2ui_delete_surface",
        "a2ui_handle_connector_action",
      ])
    })

    it("each tool has a non-empty description and an object inputSchema", () => {
      for (const tool of A2UI_BRIDGE_TOOLS) {
        expect(tool.name).toMatch(/^a2ui_/)
        expect(tool.description.length).toBeGreaterThan(10)
        expect(tool.inputSchema).toMatchObject({ type: "object" })
        // every tool requires at least one field
        expect(
          Array.isArray((tool.inputSchema as { required?: unknown[] }).required) &&
            ((tool.inputSchema as { required: unknown[] }).required.length ?? 0) > 0
        ).toBe(true)
      }
    })

    it("the create-surface tool advertises the four surface types", () => {
      const create = A2UI_BRIDGE_TOOLS.find((t) => t.name === "a2ui_create_surface")!
      const props = (create.inputSchema as Record<string, unknown>).properties as Record<
        string,
        unknown
      >
      const surfaceType = props.surfaceType as { enum?: string[] }
      expect(surfaceType.enum).toEqual(["inline", "dialog", "panel", "fullscreen"])
    })

    it("the connector-action tool advertises the seven action types and five platforms", () => {
      const action = A2UI_BRIDGE_TOOLS.find((t) => t.name === "a2ui_handle_connector_action")!
      const props = (action.inputSchema as Record<string, unknown>).properties as Record<
        string,
        unknown
      >
      expect((props.actionType as { enum: string[] }).enum).toEqual([
        "button",
        "select",
        "checkbox",
        "input",
        "submit",
        "dismiss",
        "platform_specific",
      ])
      expect((props.platform as { enum: string[] }).enum).toEqual([
        "telegram",
        "discord",
        "slack",
        "lark",
        "onebot",
      ])
    })
  })

  describe("buildA2UIBridgeMcpRow", () => {
    it("produces a stdio McpServer row referencing the sidecar placeholder", () => {
      const row = buildA2UIBridgeMcpRow(1_700_000_000_000)
      expect(row.id).toBe(A2UI_BRIDGE_SERVER_ID)
      expect(row.name).toBe(A2UI_BRIDGE_SERVER_NAME)
      expect(row.transport).toBe("stdio")
      expect(row.enabled).toBe(false)
      expect(row.config).toMatchObject({
        command: "node",
        args: [`${SIDECAR_DIR_PLACEHOLDER}/a2ui-mcp.mjs`],
      })
      expect(row.appsEnabled).toEqual(defaultA2UIAppsEnabled())
      expect(row.createdAt).toBe(1_700_000_000_000)
      expect(row.updatedAt).toBe(1_700_000_000_000)
    })

    it("uses Date.now() when no timestamp is given", () => {
      const before = Date.now()
      const row = buildA2UIBridgeMcpRow()
      const after = Date.now()
      expect(row.createdAt).toBeGreaterThanOrEqual(before)
      expect(row.createdAt).toBeLessThanOrEqual(after)
    })
  })

  describe("defaultA2UIAppsEnabled", () => {
    it("turns the bridge on for writable agents and off for read-only ones", () => {
      const map = defaultA2UIAppsEnabled()
      expect(map["claude-code"]).toBe(true)
      expect(map.cursor).toBe(true)
      expect(map.cline).toBe(false)
      expect(map["roo-code"]).toBe(false)
    })
  })

  describe("isA2UIBridgeRow", () => {
    it("recognises rows by id or by name, otherwise rejects", () => {
      expect(isA2UIBridgeRow({ id: A2UI_BRIDGE_SERVER_ID })).toBe(true)
      expect(isA2UIBridgeRow({ name: A2UI_BRIDGE_SERVER_NAME })).toBe(true)
      expect(isA2UIBridgeRow({ id: "other", name: "other" })).toBe(false)
      expect(isA2UIBridgeRow(null)).toBe(false)
    })
  })

  describe("namespacedA2UIToolNames", () => {
    it("prefixes every tool with the SDK's mcp__<server>__ namespace", () => {
      const names = namespacedA2UIToolNames()
      expect(names).toEqual(A2UI_BRIDGE_TOOLS.map((t) => `mcp__a2ui-bridge__${t.name}`))
    })
  })

  // Drift guard: the sidecar runtime servers build their schemas from
  // `sidecar/a2ui-tools/tool-defs.mjs`, which cannot import this TS canonical
  // (the sidecar is a separate Node project). This block is the cross-check
  // that prevents the two sources from silently diverging.
  describe("parity with sidecar tool-defs.mjs", () => {
    it("server identity matches", () => {
      expect(sidecarDefs.SERVER_NAME).toBe(A2UI_BRIDGE_SERVER_NAME)
      expect(sidecarDefs.SERVER_VERSION).toBe(A2UI_BRIDGE_VERSION)
    })

    it("tool names match in order", () => {
      expect(sidecarDefs.TOOL_NAMES).toEqual(A2UI_BRIDGE_TOOLS.map((t) => t.name))
    })

    it("descriptions and raw input schemas match the canonical tools", () => {
      for (const tool of A2UI_BRIDGE_TOOLS) {
        const name = tool.name as keyof typeof sidecarDefs.TOOL_DESCRIPTIONS
        expect(sidecarDefs.TOOL_DESCRIPTIONS[name]).toBe(tool.description)
        expect(sidecarDefs.RAW_INPUT_SCHEMAS[name]).toEqual(tool.inputSchema)
      }
    })

    it("namespaced names match", () => {
      expect(sidecarDefs.namespacedA2UIToolNames()).toEqual(namespacedA2UIToolNames())
    })
  })
})
