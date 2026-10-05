import test from "node:test"
import assert from "node:assert/strict"

import {
  A2UI_TOOL_NAMES,
  buildA2UIToolDefinitions,
  namespacedA2UIToolNames,
  SERVER_NAME,
} from "./tools.ts"

test("the A2UI tools are engine-neutral definitions, resident by default", () => {
  const definitions = buildA2UIToolDefinitions({ sessionId: "s", emit: () => {} })
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    A2UI_TOOL_NAMES
  )
  for (const definition of definitions) {
    assert.equal(definition.alwaysLoad, true)
    assert.equal(definition._meta, undefined)
  }
  const deferred = buildA2UIToolDefinitions({ sessionId: "s", emit: () => {}, alwaysLoad: false })
  assert.ok(deferred.every((definition) => definition.alwaysLoad === undefined))
})

test("an A2UI tool dispatches to the renderer through emit", async () => {
  const events: unknown[] = []
  const [create] = buildA2UIToolDefinitions({
    sessionId: "sess",
    emit: (event) => events.push(event),
  })
  const result = (await create!.handler({ surfaceId: "surface-1", components: [] })) as {
    isError?: boolean
  }
  assert.notEqual(result.isError, true)
  assert.equal(events.length, 1)
  assert.deepEqual((events[0] as { type: string; sessionId: string }).type, "a2ui_dispatch")
  assert.equal((events[0] as { sessionId: string }).sessionId, "sess")
})

test("namespaced names address the A2UI server", () => {
  assert.deepEqual(
    namespacedA2UIToolNames(),
    A2UI_TOOL_NAMES.map((name) => `mcp__${SERVER_NAME}__${name}`)
  )
})
