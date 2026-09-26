import { test } from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"

import { parseToolArgs, toolInputJsonSchema } from "./args.ts"

const shape = {
  path: z.string().min(1).describe("File to read"),
  limit: z.number().int().max(100).default(20),
  mode: z.enum(["fast", "full"]).optional(),
}

test("a zod raw shape becomes the input JSON Schema, defaults and bounds included", () => {
  const schema = toolInputJsonSchema(shape)
  assert.equal(schema.type, "object")
  const properties = schema.properties as Record<string, Record<string, unknown>>
  assert.equal(properties.path!.minLength, 1)
  assert.equal(properties.path!.description, "File to read")
  assert.equal(properties.limit!.default, 20)
  assert.equal(properties.limit!.maximum, 100)
  assert.deepEqual(properties.mode!.enum, ["fast", "full"])
  // Input schema: a field with a default is optional for the caller.
  assert.deepEqual(schema.required, ["path"])
})

test("a zod object converts the same way as its raw shape", () => {
  assert.deepEqual(toolInputJsonSchema(z.object(shape)), toolInputJsonSchema(shape))
})

test("anything that is not an object schema falls back to an empty object schema", () => {
  const empty = { type: "object", properties: {} }
  assert.deepEqual(toolInputJsonSchema(undefined), empty)
  assert.deepEqual(toolInputJsonSchema("nope"), empty)
  // MCP needs an object at the top level; a string schema is not one.
  assert.deepEqual(toolInputJsonSchema(z.string()), empty)
})

test("parsing applies defaults and keeps valid values", () => {
  assert.deepEqual(parseToolArgs(shape, { path: "a.txt" }), {
    ok: true,
    value: { path: "a.txt", limit: 20 },
  })
})

test("a validation failure names each failing path", () => {
  const parsed = parseToolArgs(shape, { path: "", limit: 500 })
  assert.equal(parsed.ok, false)
  assert.ok(!parsed.ok)
  assert.match(parsed.message, /^path: /)
  assert.match(parsed.message, /; limit: /)
})

test("a root-level failure is reported as (root)", () => {
  const parsed = parseToolArgs(z.string(), 42)
  assert.ok(!parsed.ok)
  assert.match(parsed.message, /^\(root\): /)
})

test("at most five issues are reported", () => {
  const wide = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`field${i}`, z.string()]))
  const parsed = parseToolArgs(wide, {})
  assert.ok(!parsed.ok)
  assert.equal(parsed.message.split("; ").length, 5)
})

test("no schema passes the arguments through", () => {
  assert.deepEqual(parseToolArgs(undefined, { a: 1 }), { ok: true, value: { a: 1 } })
  assert.deepEqual(parseToolArgs(undefined, undefined), { ok: true, value: {} })
})

test("a raw shape with a non-zod value throws at parse time (the fail-open catch covers construction only)", () => {
  // Zod 4 builds `z.object` lazily, so a bad shape surfaces in `safeParse`,
  // outside the catch. Pinned as it is today; the move keeps behaviour.
  assert.throws(
    () => parseToolArgs({ path: "not a zod schema" }, { path: 1 }),
    /expected a Zod schema/
  )
})
