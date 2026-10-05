import { test } from "node:test"
import assert from "node:assert/strict"

import { z } from "zod"

import { defineCategory, tool, type ToolDefinition } from "./define.ts"

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

test("tool() builds an engine-neutral definition with typed arguments", async () => {
  const shape = { path: z.string(), limit: z.number().default(10) }
  const seen: unknown[] = []
  const def = tool("read_file", "Read a file", shape, async (args, extra) => {
    seen.push(args.path, args.limit, extra?.signal)
    return { content: [{ type: "text", text: args.path }] }
  })
  assert.deepEqual(Object.keys(def).sort(), ["description", "handler", "inputSchema", "name"])
  assert.equal(def.inputSchema, shape)
  const signal = new AbortController().signal
  assert.deepEqual(await def.handler({ path: "a.ts", limit: 3 }, { signal }), {
    content: [{ type: "text", text: "a.ts" }],
  })
  assert.deepEqual(seen, ["a.ts", 3, signal])
})

test("tool() keeps presentation options as neutral fields, never engine metadata", () => {
  const def = tool("ls", "List", {}, async () => ({ content: [] }), {
    alwaysLoad: true,
    searchHint: "directory listing",
    annotations: { readOnlyHint: true },
  })
  assert.equal(def.alwaysLoad, true)
  assert.equal(def.searchHint, "directory listing")
  assert.deepEqual(def.annotations, { readOnlyHint: true })
  assert.equal(def._meta, undefined)
  const plain = tool("x", "X", {}, async () => ({ content: [] }), { alwaysLoad: false })
  assert.equal("alwaysLoad" in plain, false)
})
