import { VerificationReportSchema } from "../contracts/schemas"
import {
  parseJsonDocument,
  validateJsonSubset,
  verifySchemaFixture,
  verifyTextBasic,
} from "./text-verifiers"

const ID = "55555555-5555-4555-8555-555555555555"

describe("text verifiers", () => {
  it("parses fenced and bare JSON", () => {
    expect(parseJsonDocument('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJsonDocument(' {"a":1} ')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJsonDocument("{a:1}").ok).toBe(false)
  })

  it("text_basic checks format only and reports schema_only", () => {
    const passed = verifyTextBasic({
      reportId: ID,
      text: "hello",
      rules: { maxChars: 10, forbiddenSubstrings: ["secret"] },
    })
    expect(passed.status).toBe("passed")
    expect(passed.level).toBe("schema_only")
    expect(VerificationReportSchema.parse(passed)).toEqual(passed)

    const failed = verifyTextBasic({
      reportId: ID,
      text: '{"a":1} secret',
      rules: { maxChars: 5, forbiddenSubstrings: ["secret"], requiredJsonFields: ["b"] },
    })
    expect(failed.status).toBe("failed")
    expect(failed.checks.map((c) => [c.check_id, c.status])).toEqual([
      ["non_empty", "passed"],
      ["max_length", "failed"],
      ["json_parse", "failed"],
      ["forbidden", "failed"],
    ])
    const missingField = verifyTextBasic({
      reportId: ID,
      text: '{"a":1}',
      rules: { requiredJsonFields: ["a", "b"] },
    })
    expect(missingField.checks.at(-1)).toMatchObject({
      check_id: "required_fields",
      status: "failed",
      summary: "missing: b",
    })
  })

  it("validates the JSON Schema subset", () => {
    const schema = {
      type: "object",
      required: ["items", "kind"],
      properties: {
        items: { type: "array", minItems: 1, items: { type: "integer" } },
        kind: { type: "string", enum: ["a", "b"] },
        flag: { type: "boolean" },
        ratio: { type: "number" },
        nothing: { type: "null" },
      },
      additionalProperties: false,
    }
    expect(
      validateJsonSubset({ items: [1], kind: "a", flag: true, ratio: 0.5, nothing: null }, schema)
        .errors
    ).toEqual([])
    expect(
      validateJsonSubset(
        { items: [], kind: "c", extra: 1, flag: "no", ratio: "x", nothing: 1 },
        schema
      ).errors
    ).toEqual([
      "$.items needs at least 1 items",
      "$.kind is not one of the allowed values",
      "$.flag must be a boolean",
      "$.ratio must be a number",
      "$.nothing must be null",
      "$.extra is not allowed",
    ])
    expect(validateJsonSubset("x", { type: "object" }).errors).toEqual(["$ must be an object"])
    expect(validateJsonSubset(1.5, { type: "integer" }).errors).toEqual(["$ must be an integer"])
    expect(validateJsonSubset(1, { type: "array" }).errors).toEqual(["$ must be an array"])
    expect(validateJsonSubset(1, { type: "string" }).errors).toEqual(["$ must be a string"])
  })

  it("schema_fixture is inconclusive on keywords it cannot evaluate, never a pass", () => {
    const report = verifySchemaFixture({
      reportId: ID,
      text: '{"a":"x"}',
      schema: { type: "object", pattern: "^x$" },
    })
    expect(report.status).toBe("inconclusive")
    const weirdType = verifySchemaFixture({ reportId: ID, text: "1", schema: { type: "decimal" } })
    expect(weirdType.status).toBe("inconclusive")
  })

  it("schema_fixture compares fixture expectations and reports tool_verified", () => {
    const schema = { type: "object", required: ["id"], properties: { id: { type: "integer" } } }
    const passed = verifySchemaFixture({
      reportId: ID,
      text: '{"id":7}',
      schema,
      expectedFields: { id: 7 },
    })
    expect(passed).toMatchObject({ status: "passed", level: "tool_verified" })
    const wrong = verifySchemaFixture({
      reportId: ID,
      text: '{"id":8}',
      schema,
      expectedFields: { id: 7 },
    })
    expect(wrong.status).toBe("failed")
    expect(verifySchemaFixture({ reportId: ID, text: "nope", schema }).status).toBe("failed")
  })
})
