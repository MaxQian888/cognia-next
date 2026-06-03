// node --test coverage for the shared A2UI bridge tool definitions.

import test from "node:test"
import assert from "node:assert/strict"

import {
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  RAW_INPUT_SCHEMAS,
  CONNECTOR_ACTION_TYPES,
  CONNECTOR_PLATFORMS,
  SURFACE_TYPES,
  rawTools,
  buildDispatch,
  namespacedA2UIToolNames,
} from "./tool-defs.mjs"

test("exposes the five contracted tool names", () => {
  assert.deepEqual(TOOL_NAMES, [
    "a2ui_create_surface",
    "a2ui_update_components",
    "a2ui_data_model_update",
    "a2ui_delete_surface",
    "a2ui_handle_connector_action",
  ])
})

test("server identity is stable", () => {
  assert.equal(SERVER_NAME, "a2ui-bridge")
  assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+$/)
})

test("every tool has a description and a raw input schema with required[]", () => {
  for (const name of TOOL_NAMES) {
    assert.ok(TOOL_DESCRIPTIONS[name]?.length > 10, `description for ${name}`)
    const schema = RAW_INPUT_SCHEMAS[name]
    assert.equal(schema.type, "object")
    assert.equal(schema.additionalProperties, false)
    assert.ok(Array.isArray(schema.required) && schema.required.length > 0)
  }
})

test("rawTools mirrors names + descriptions + schemas", () => {
  const tools = rawTools()
  assert.equal(tools.length, TOOL_NAMES.length)
  for (const tool of tools) {
    assert.equal(tool.description, TOOL_DESCRIPTIONS[tool.name])
    assert.equal(tool.inputSchema, RAW_INPUT_SCHEMAS[tool.name])
  }
})

test("create-surface advertises the four surface types", () => {
  assert.deepEqual(RAW_INPUT_SCHEMAS.a2ui_create_surface.properties.surfaceType.enum, SURFACE_TYPES)
})

test("connector-action advertises the seven action types and five platforms", () => {
  const props = RAW_INPUT_SCHEMAS.a2ui_handle_connector_action.properties
  assert.deepEqual(props.actionType.enum, CONNECTOR_ACTION_TYPES)
  assert.deepEqual(props.platform.enum, CONNECTOR_PLATFORMS)
  assert.deepEqual(RAW_INPUT_SCHEMAS.a2ui_handle_connector_action.required, [
    "surfaceId",
    "actionType",
  ])
})

test("buildDispatch maps create-surface args", () => {
  const msg = buildDispatch("a2ui_create_surface", {
    surfaceId: "s1",
    surfaceType: "panel",
    title: "Hi",
  })
  assert.deepEqual(msg, {
    type: "createSurface",
    surfaceId: "s1",
    surfaceType: "panel",
    catalogId: undefined,
    title: "Hi",
    widget: undefined,
  })
})

test("buildDispatch maps update-components + data-model (merge default true)", () => {
  assert.deepEqual(
    buildDispatch("a2ui_update_components", {
      surfaceId: "s",
      components: [{ id: "a", component: "Text" }],
    }),
    {
      type: "updateComponents",
      surfaceId: "s",
      components: [{ id: "a", component: "Text" }],
    }
  )
  assert.equal(buildDispatch("a2ui_data_model_update", { surfaceId: "s", data: {} }).merge, true)
  assert.equal(
    buildDispatch("a2ui_data_model_update", { surfaceId: "s", data: {}, merge: false }).merge,
    false
  )
})

test("buildDispatch maps delete-surface", () => {
  assert.deepEqual(buildDispatch("a2ui_delete_surface", { surfaceId: "s" }), {
    type: "deleteSurface",
    surfaceId: "s",
  })
})

test("buildDispatch maps connector-action to a connectorAction message", () => {
  const msg = buildDispatch("a2ui_handle_connector_action", {
    surfaceId: "s1",
    componentId: "btn",
    actionType: "button",
    value: "approve",
    payload: { reason: "ok" },
    platform: "slack",
    triggerId: "t1",
    conversationKey: "ck",
  })
  assert.deepEqual(msg, {
    type: "connectorAction",
    surfaceId: "s1",
    componentId: "btn",
    actionType: "button",
    value: "approve",
    payload: { reason: "ok" },
    platform: "slack",
    triggerId: "t1",
    conversationKey: "ck",
  })
})

test("buildDispatch returns null for an unknown tool", () => {
  assert.equal(buildDispatch("nope", {}), null)
})

test("namespacedA2UIToolNames prefixes every tool", () => {
  assert.deepEqual(
    namespacedA2UIToolNames(),
    TOOL_NAMES.map((n) => `mcp__a2ui-bridge__${n}`)
  )
})
