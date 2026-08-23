import * as v from "valibot"

import { UnsupportedSchemaError, valibotToJsonSchema } from "./valibot-json-schema"

/** Drop the `$schema` header so assertions stay about the shape. */
function body(schema: v.GenericSchema) {
  const { $schema, ...rest } = valibotToJsonSchema(schema) as Record<string, unknown>
  expect($schema).toBe("https://json-schema.org/draft/2020-12/schema")
  return rest
}

describe("valibotToJsonSchema", () => {
  it("converts primitives", () => {
    expect(body(v.string())).toEqual({ type: "string" })
    expect(body(v.number())).toEqual({ type: "number" })
    expect(body(v.boolean())).toEqual({ type: "boolean" })
    expect(body(v.null())).toEqual({ type: "null" })
  })

  it("marks only non-optional object members required", () => {
    expect(body(v.object({ path: v.string(), encoding: v.optional(v.string()) }))).toEqual({
      type: "object",
      properties: { path: { type: "string" }, encoding: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    })
  })

  it("omits `required` entirely when every member is optional", () => {
    expect(body(v.object({ a: v.optional(v.string()) }))).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    })
  })

  it("keeps loose objects open and strict objects closed", () => {
    expect(body(v.looseObject({ a: v.string() }))).toMatchObject({ additionalProperties: true })
    expect(body(v.strictObject({ a: v.string() }))).toMatchObject({ additionalProperties: false })
  })

  it("converts arrays, records, enums and literals", () => {
    expect(body(v.array(v.string()))).toEqual({ type: "array", items: { type: "string" } })
    expect(body(v.record(v.string(), v.number()))).toEqual({
      type: "object",
      additionalProperties: { type: "number" },
    })
    expect(body(v.picklist(["a", "b"]))).toEqual({ enum: ["a", "b"] })
    expect(body(v.literal(7))).toEqual({ const: 7 })
  })

  it("converts unions to anyOf and nullable to a null branch", () => {
    expect(body(v.union([v.string(), v.number()]))).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    })
    expect(body(v.nullable(v.string()))).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    })
  })

  it("carries string and number constraints across", () => {
    expect(body(v.pipe(v.string(), v.minLength(2), v.maxLength(8)))).toEqual({
      type: "string",
      minLength: 2,
      maxLength: 8,
    })
    expect(body(v.pipe(v.number(), v.minValue(1), v.maxValue(10), v.integer()))).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 10,
    })
  })

  it("routes length constraints to items for arrays and characters for strings", () => {
    expect(body(v.pipe(v.array(v.string()), v.minLength(1)))).toMatchObject({ minItems: 1 })
    expect(body(v.pipe(v.string(), v.minLength(1)))).toMatchObject({ minLength: 1 })
  })

  it("carries descriptions, which is what the model actually reads", () => {
    expect(
      body(v.object({ path: v.pipe(v.string(), v.description("Absolute file path")) }))
    ).toMatchObject({ properties: { path: { description: "Absolute file path" } } })
  })

  it("maps the common string formats", () => {
    expect(body(v.pipe(v.string(), v.email()))).toMatchObject({ format: "email" })
    expect(body(v.pipe(v.string(), v.url()))).toMatchObject({ format: "uri" })
    expect(body(v.pipe(v.string(), v.uuid()))).toMatchObject({ format: "uuid" })
    expect(body(v.pipe(v.string(), v.isoTimestamp()))).toMatchObject({ format: "date-time" })
  })

  it("converts a regex constraint without its delimiters", () => {
    expect(body(v.pipe(v.string(), v.regex(/^[a-z]+$/)))).toMatchObject({ pattern: "^[a-z]+$" })
  })

  it("nests to arbitrary depth", () => {
    expect(
      body(v.object({ outer: v.object({ inner: v.array(v.object({ leaf: v.string() })) }) }))
    ).toMatchObject({
      properties: {
        outer: {
          properties: {
            inner: { type: "array", items: { properties: { leaf: { type: "string" } } } },
          },
        },
      },
    })
  })

  it("refuses a schema it cannot express, naming the type and the path", () => {
    let thrown: unknown
    try {
      valibotToJsonSchema(v.object({ when: v.date() }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(UnsupportedSchemaError)
    expect(thrown).toMatchObject({ code: "unsupported_schema", schemaType: "date", path: "when" })
    expect((thrown as Error).message).toContain("raw JSON Schema")
  })

  it("refuses an unsupported validation rather than dropping it", () => {
    expect(() => valibotToJsonSchema(v.pipe(v.string(), v.includes("x")))).toThrow(
      UnsupportedSchemaError
    )
  })

  it("names the nested path of the offending node", () => {
    expect(() => valibotToJsonSchema(v.object({ a: v.array(v.date()) }))).toThrow(
      expect.objectContaining({ path: "a[]" })
    )
  })
})
