import { test } from "node:test"
import assert from "node:assert/strict"

import { defineCategory, type ToolDefinition } from "./define.ts"

test("static categories retain definition identity and order", () => {
  const tools: readonly ToolDefinition[] = [
    { name: "first", handler: () => "first" },
    { name: "second", handler: () => "second" },
  ]
  const category = defineCategory({
    id: "static",
    isEnabled: ({ enabled }: { enabled: boolean }) => enabled,
    tools,
  })
  assert.equal(category.id, "static")
  assert.equal(category.isEnabled({ enabled: false }), false)
  assert.equal(category.isEnabled({ enabled: true }), true)
  assert.equal(category.create({ enabled: true }), tools)
})

test("session-bound categories create lazily using the current context", () => {
  const contexts: { sessionId: string }[] = []
  const category = defineCategory({
    id: "session",
    isEnabled: () => true,
    tools: (context: { sessionId: string }) => {
      contexts.push(context)
      return [{ name: "session", handler: () => context.sessionId }]
    },
  })
  assert.deepEqual(contexts, [])
  const first = { sessionId: "first" }
  const second = { sessionId: "second" }
  const firstTools = category.create(first)
  const secondTools = category.create(second)
  assert.equal(contexts[0], first)
  assert.equal(contexts[1], second)
  assert.equal(firstTools[0]!.handler({}), "first")
  assert.equal(secondTools[0]!.handler({}), "second")
})
