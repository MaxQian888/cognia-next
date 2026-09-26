import { test } from "node:test"
import assert from "node:assert/strict"

import { jsonSchemaPropToZod, jsonSchemaToZodShape } from "./json-schema-zod.ts"

test("jsonSchemaToZodShape returns empty shape for non-object schemas", () => {
  assert.deepEqual(jsonSchemaToZodShape(null), {})
  assert.deepEqual(jsonSchemaToZodShape(undefined), {})
  assert.deepEqual(jsonSchemaToZodShape({ type: "string" }), {})
  assert.deepEqual(jsonSchemaToZodShape({ type: "object" }), {})
})

test("jsonSchemaToZodShape produces one zod entry per declared property", () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: {
      a: { type: "string" },
      b: { type: "number" },
      c: { type: "boolean" },
    },
    required: ["a"],
  })
  assert.deepEqual(Object.keys(shape).sort(), ["a", "b", "c"])
})

test("jsonSchemaPropToZod handles the common primitive types", () => {
  // Smoke-check: each call returns a zod-like object with a parse() method.
  const types = ["string", "number", "integer", "boolean", "null", "array", "object", "weird"]
  for (const t of types) {
    const schema = jsonSchemaPropToZod({ type: t }, true)
    assert.equal(typeof schema.parse, "function", `expected zod for type=${t}`)
  }
})

test("jsonSchemaPropToZod wraps non-required fields in .optional()", () => {
  const required = jsonSchemaPropToZod({ type: "string" }, true)
  const optional = jsonSchemaPropToZod({ type: "string" }, false)
  // Optional schemas expose isOptional() on zod v3+ instances.
  assert.equal(typeof required.isOptional, "function")
  assert.equal(required.isOptional(), false)
  assert.equal(optional.isOptional(), true)
})

test("jsonSchemaPropToZod preserves descriptions on known fields", () => {
  const schema = jsonSchemaPropToZod({ type: "string", description: "field docs" }, true)
  assert.equal(schema.description, "field docs")
})

test("jsonSchemaPropToZod accepts null as a declared enum member", () => {
  // `enum: [...,null]` is how a schema says "one of these, or explicitly
  // cleared". Dropping the null made this rail reject a value the schema
  // declares, while the ai-sdk rail accepted it — the same tool validating
  // differently per provider.
  const schema = jsonSchemaPropToZod({ type: ["string", "null"], enum: ["a", "b", null] }, true)
  assert.equal(schema.safeParse("a").success, true)
  assert.equal(schema.safeParse(null).success, true)
  assert.equal(schema.safeParse("nope").success, false)
})

test("jsonSchemaPropToZod maps a null-only enum to null, not to undefined", () => {
  // `enum: [null]` is legal JSON Schema for "must be null". Filtering the only
  // member out once left a union of two `z.literal(undefined)` — a schema whose
  // declared value was the one thing it rejected.
  const schema = jsonSchemaPropToZod({ enum: [null] }, true)
  assert.equal(schema.safeParse(null).success, true)
  assert.equal(schema.safeParse("a").success, false)
})

test("jsonSchemaPropToZod maps a single-member enum to that literal", () => {
  const schema = jsonSchemaPropToZod({ enum: [7] }, true)
  assert.equal(schema.safeParse(7).success, true)
  assert.equal(schema.safeParse(8).success, false)
})

test("jsonSchemaPropToZod keeps mixed-type enums exact", () => {
  const schema = jsonSchemaPropToZod({ enum: ["a", 2, true] }, true)
  for (const value of ["a", 2, true]) {
    assert.equal(schema.safeParse(value).success, true, `expected ${String(value)} to parse`)
  }
  assert.equal(schema.safeParse("2").success, false)
})

test("jsonSchemaPropToZod maps oneOf to a real union", () => {
  // The model-visible MCP schema is derived from THIS zod shape, not from the
  // manifest JSON Schema. Before `oneOf` was handled, every discriminated
  // union fell through to `z.unknown()` — which is how computer-use's entire
  // action vocabulary reached the model as an opaque object.
  const schema = jsonSchemaPropToZod(
    {
      oneOf: [
        { type: "object", properties: { kind: { const: "click" } }, required: ["kind"] },
        {
          type: "object",
          properties: { kind: { const: "pressKey" }, chord: { type: "string" } },
          required: ["kind", "chord"],
        },
      ],
    },
    true
  )
  assert.equal(schema.safeParse({ kind: "click" }).success, true)
  assert.equal(schema.safeParse({ kind: "pressKey", chord: "ctrl+c" }).success, true)
  assert.equal(schema.safeParse({ kind: "nope" }).success, false)
})

test("jsonSchemaPropToZod treats anyOf like oneOf", () => {
  const schema = jsonSchemaPropToZod({ anyOf: [{ type: "string" }, { type: "number" }] }, true)
  assert.equal(schema.safeParse("a").success, true)
  assert.equal(schema.safeParse(3).success, true)
  assert.equal(schema.safeParse(true).success, false)
})

test("jsonSchemaPropToZod keeps a single-branch oneOf as that branch", () => {
  const schema = jsonSchemaPropToZod({ oneOf: [{ type: "string" }] }, true)
  assert.equal(schema.safeParse("a").success, true)
  assert.equal(schema.safeParse(1).success, false)
})

test("jsonSchemaPropToZod keeps string, number and array bounds", () => {
  const name = jsonSchemaPropToZod(
    { type: "string", minLength: 2, maxLength: 3, pattern: "^a" },
    true
  )
  assert.equal(name.safeParse("ab").success, true)
  assert.equal(name.safeParse("a").success, false)
  assert.equal(name.safeParse("abcd").success, false)
  assert.equal(name.safeParse("bb").success, false)
  // An unsupported pattern is dropped rather than bricking the tool.
  assert.equal(
    jsonSchemaPropToZod({ type: "string", pattern: "(" }, true).safeParse("x").success,
    true
  )

  const count = jsonSchemaPropToZod({ type: "integer", minimum: 1, exclusiveMaximum: 5 }, true)
  assert.equal(count.safeParse(4).success, true)
  assert.equal(count.safeParse(5).success, false)
  assert.equal(count.safeParse(1.5).success, false)

  const list = jsonSchemaPropToZod({ type: "array", items: { type: "string" }, maxItems: 1 }, true)
  assert.equal(list.safeParse(["a"]).success, true)
  assert.equal(list.safeParse(["a", "b"]).success, false)
  assert.equal(list.safeParse([1]).success, false)
})

test("jsonSchemaPropToZod recurses into nested objects and honours additionalProperties", () => {
  const open = jsonSchemaPropToZod(
    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    true
  )
  assert.deepEqual(open.parse({ id: "a", extra: 1 }), { id: "a", extra: 1 })
  assert.equal(open.safeParse({}).success, false)
  const closed = jsonSchemaPropToZod(
    { type: "object", properties: { id: { type: "string" } }, additionalProperties: false },
    true
  )
  assert.equal(closed.safeParse({ id: "a", extra: 1 }).success, false)
  // An object without properties stays an open record.
  assert.equal(jsonSchemaPropToZod({ type: "object" }, true).safeParse({ any: 1 }).success, true)
})

test("jsonSchemaPropToZod applies a default only to an optional field", () => {
  const optional = jsonSchemaPropToZod({ type: "number", default: 3 }, false)
  assert.equal(optional.parse(undefined), 3)
  const required = jsonSchemaPropToZod({ type: "number", default: 3 }, true)
  assert.equal(required.safeParse(undefined).success, false)
})

test("jsonSchemaPropToZod maps const to a literal", () => {
  const schema = jsonSchemaPropToZod({ const: "fixed" }, true)
  assert.equal(schema.safeParse("fixed").success, true)
  assert.equal(schema.safeParse("other").success, false)
})
