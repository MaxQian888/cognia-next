import {
  jsonSchemaPropToZod,
  jsonSchemaToZodShape,
  isValidatableObjectSchema,
  validateAgainstJsonSchema,
  formatZodIssues,
  summarizeZodError,
} from "./schema-validate"
import { z } from "zod"

const personSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Full name" },
    age: { type: "integer" },
    tags: { type: "array", items: { type: "string" } },
    active: { type: "boolean" },
  },
  required: ["name", "age"],
}

describe("jsonSchemaPropToZod", () => {
  it("maps primitive types", () => {
    expect(jsonSchemaPropToZod({ type: "string" }, true).safeParse("x").success).toBe(true)
    expect(jsonSchemaPropToZod({ type: "number" }, true).safeParse(1).success).toBe(true)
    expect(jsonSchemaPropToZod({ type: "integer" }, true).safeParse(1.5).success).toBe(false)
    expect(jsonSchemaPropToZod({ type: "boolean" }, true).safeParse(true).success).toBe(true)
    expect(jsonSchemaPropToZod({ type: "null" }, true).safeParse(null).success).toBe(true)
  })

  it("maps arrays with item schemas", () => {
    const arr = jsonSchemaPropToZod({ type: "array", items: { type: "number" } }, true)
    expect(arr.safeParse([1, 2]).success).toBe(true)
    expect(arr.safeParse(["a"]).success).toBe(false)
  })

  it("validates nested objects with declared properties", () => {
    const nested = jsonSchemaPropToZod(
      { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      true
    )
    expect(nested.safeParse({ id: "a" }).success).toBe(true)
    expect(nested.safeParse({}).success).toBe(false)
  })

  it("accepts any record for a property-less object", () => {
    const obj = jsonSchemaPropToZod({ type: "object" }, true)
    expect(obj.safeParse({ anything: 1 }).success).toBe(true)
  })

  it("falls back to unknown for unrecognized types", () => {
    expect(jsonSchemaPropToZod({ type: "weird" }, true).safeParse(Symbol("x")).success).toBe(true)
    expect(jsonSchemaPropToZod(null, true).safeParse("anything").success).toBe(true)
  })

  it("makes non-required fields optional", () => {
    const optional = jsonSchemaPropToZod({ type: "string" }, false)
    expect(optional.safeParse(undefined).success).toBe(true)
  })
})

describe("jsonSchemaToZodShape", () => {
  it("returns a shape keyed by property names", () => {
    const shape = jsonSchemaToZodShape(personSchema)
    expect(Object.keys(shape).sort()).toEqual(["active", "age", "name", "tags"])
  })

  it("returns an empty shape for non-object schemas", () => {
    expect(jsonSchemaToZodShape({ type: "string" })).toEqual({})
    expect(jsonSchemaToZodShape(null)).toEqual({})
    expect(jsonSchemaToZodShape({ type: "object" })).toEqual({})
  })
})

describe("isValidatableObjectSchema", () => {
  it("is true only for object schemas with properties", () => {
    expect(isValidatableObjectSchema(personSchema)).toBe(true)
    expect(isValidatableObjectSchema({ type: "object" })).toBe(false)
    expect(isValidatableObjectSchema({ type: "string" })).toBe(false)
    expect(isValidatableObjectSchema(null)).toBe(false)
  })
})

describe("validateAgainstJsonSchema", () => {
  it("passes a conforming object", () => {
    const r = validateAgainstJsonSchema(personSchema, { name: "Ada", age: 36 })
    expect(r.ok).toBe(true)
  })

  it("tolerates extra keys", () => {
    const r = validateAgainstJsonSchema(personSchema, { name: "Ada", age: 36, extra: "ok" })
    expect(r.ok).toBe(true)
  })

  it("fails on a missing required field", () => {
    const r = validateAgainstJsonSchema(personSchema, { name: "Ada" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/age/)
  })

  it("fails on a type mismatch", () => {
    const r = validateAgainstJsonSchema(personSchema, { name: "Ada", age: "old" })
    expect(r.ok).toBe(false)
  })

  it("fails when the value is not an object", () => {
    const r = validateAgainstJsonSchema(personSchema, ["not", "an", "object"])
    expect(r.ok).toBe(false)
  })

  it("passes through non-object schemas without enforcing", () => {
    expect(validateAgainstJsonSchema({ type: "string" }, 123).ok).toBe(true)
    expect(validateAgainstJsonSchema(null, undefined).ok).toBe(true)
  })
})

describe("formatZodIssues / summarizeZodError", () => {
  it("formats issues as path: message lines", () => {
    const err = z.object({ name: z.string() }).safeParse({})
    if (err.success) throw new Error("expected failure")
    const lines = formatZodIssues(err.error)
    expect(lines[0]).toMatch(/^name: /)
  })

  it("labels root-level issues", () => {
    const err = z.object({}).safeParse("notanobject")
    if (err.success) throw new Error("expected failure")
    expect(formatZodIssues(err.error)[0]).toMatch(/^\(root\): /)
  })

  it("summarizes errors into a corrective re-prompt", () => {
    const snippet = summarizeZodError(["age: Required"])
    expect(snippet).toMatch(/did not satisfy/)
    expect(snippet).toContain("age: Required")
    expect(snippet).toMatch(/corrected JSON/)
  })

  it("returns an empty string when there are no errors", () => {
    expect(summarizeZodError([])).toBe("")
  })
})
