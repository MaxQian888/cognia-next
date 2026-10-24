import test from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"

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

test("the zod shapes accept computed maps, with null removal only on data updates", () => {
  const definitions = buildA2UIToolDefinitions({ sessionId: "s", emit: () => {} })
  const shape = (name: string) =>
    z.object(
      definitions.find((definition) => definition.name === name)!.inputSchema as z.ZodRawShape
    )
  const total = { op: "add", args: [{ path: "/a" }, 1] }

  const create = shape("a2ui_create_surface")
  assert.ok(
    create.safeParse({ surfaceId: "s", surfaceType: "inline", computed: { "/total": total } })
      .success
  )
  assert.equal(
    create.safeParse({ surfaceId: "s", surfaceType: "inline", computed: { "/total": null } })
      .success,
    false
  )

  const update = shape("a2ui_data_model_update")
  assert.ok(
    update.safeParse({ surfaceId: "s", data: {}, computed: { "/total": total, "/old": null } })
      .success
  )
})

test("a data update forwards computed to the renderer dispatch", async () => {
  const events: { message?: { computed?: unknown } }[] = []
  const definitions = buildA2UIToolDefinitions({
    sessionId: "s",
    emit: (event) => events.push(event as { message?: { computed?: unknown } }),
  })
  const update = definitions.find((definition) => definition.name === "a2ui_data_model_update")!
  await update.handler({ surfaceId: "s", data: {}, merge: true, computed: { "/old": null } })
  assert.deepEqual(events[0]?.message?.computed, { "/old": null })
})
