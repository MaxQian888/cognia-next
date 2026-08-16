import { test } from "node:test"
import assert from "node:assert/strict"

import { generateSdkDeclaration, renderSchema } from "./sdk-declaration.mjs"
import limits from "../../../lib/ai/code-mode/limits.json" with { type: "json" }

test("maps the JSON Schema primitives", () => {
  assert.equal(renderSchema({ type: "string" }), "string")
  assert.equal(renderSchema({ type: "number" }), "number")
  assert.equal(renderSchema({ type: "integer" }), "number")
  assert.equal(renderSchema({ type: "boolean" }), "boolean")
  assert.equal(renderSchema({ type: "null" }), "null")
})

test("renders arrays, including nested ones", () => {
  assert.equal(renderSchema({ type: "array", items: { type: "string" } }), "Array<string>")
  assert.equal(
    renderSchema({ type: "array", items: { type: "array", items: { type: "number" } } }),
    "Array<Array<number>>"
  )
  assert.equal(renderSchema({ type: "array" }), "Array<unknown>")
})

// `any` would let generated code type-check against a shape the validator
// then rejects, so an undescribed schema is `unknown`.
test("falls back to unknown rather than any", () => {
  assert.equal(renderSchema({}), "unknown")
  assert.equal(renderSchema({ type: "unrecognised" }), "unknown")
  assert.equal(renderSchema(undefined), "unknown")
  assert.equal(renderSchema(null), "unknown")
})

test("renders enums and unions", () => {
  assert.equal(renderSchema({ enum: ["a", "b"] }), '"a" | "b"')
  assert.equal(renderSchema({ anyOf: [{ type: "string" }, { type: "number" }] }), "string | number")
  assert.equal(renderSchema({ oneOf: [{ type: "boolean" }, { type: "null" }] }), "boolean | null")
})

test("marks non-required properties optional and documents described ones", () => {
  const rendered = renderSchema({
    type: "object",
    properties: {
      path: { type: "string", description: "File to read" },
      limit: { type: "number" },
    },
    required: ["path"],
  })
  assert.match(rendered, /path: string/)
  assert.match(rendered, /limit\?: number/)
  assert.match(rendered, /\/\*\* File to read \*\//)
})

test("quotes a property name that is not an identifier", () => {
  const rendered = renderSchema({ type: "object", properties: { "not-ident": { type: "string" } } })
  assert.match(rendered, /"not-ident"\?: string/)
})

test("does not let a description close the comment early", () => {
  const rendered = renderSchema({
    type: "object",
    properties: { a: { type: "string", description: "ends */ here" } },
  })
  assert.ok(!rendered.includes("*/ here */"))
})

test("distinguishes a closed empty object from an open one", () => {
  assert.equal(
    renderSchema({ type: "object", additionalProperties: false }),
    "Record<string, never>"
  )
  assert.equal(renderSchema({ type: "object" }), "Record<string, unknown>")
})

test("declares one async function per tool", () => {
  const out = generateSdkDeclaration([
    { name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    { name: "grep", inputSchema: { type: "object", properties: {} } },
  ])
  assert.match(out, /read\(input: \{/)
  assert.match(out, /grep\(input: Record<string, unknown>\)/)
  assert.equal((out.match(/Promise<unknown>/g) ?? []).length, 2)
})

// Claiming `()` for a tool that does take arguments would make the model write
// calls the validator rejects.
test("a tool with no declared schema takes an open bag, not nothing", () => {
  const out = generateSdkDeclaration([{ name: "codegraph_status" }])
  assert.match(out, /codegraph_status\(input: Record<string, unknown>\): Promise<unknown>/)
})

test("states the run limits alongside the API", () => {
  const out = generateSdkDeclaration([{ name: "read" }])
  assert.match(out, new RegExp(`${limits.maxToolCalls} tool calls`))
  assert.match(out, new RegExp(`${limits.wallTimeMs / 1000}s`))
  assert.match(out, /32 KiB/)
  assert.match(out, /1 MiB/)
})

test("says plainly that the SDK cannot write", () => {
  assert.match(generateSdkDeclaration([{ name: "read" }]), /None of them can write\./)
})

test("renders a tool description as a doc comment", () => {
  const out = generateSdkDeclaration([{ name: "read", description: "Read a file" }])
  assert.match(out, /\/\*\* Read a file \*\//)
})

test("produces a well-formed block for an empty tool list", () => {
  const out = generateSdkDeclaration([])
  assert.match(out, /declare const cognia: \{\n\}/)
})

test("honours injected limits", () => {
  const out = generateSdkDeclaration([{ name: "read" }], { ...limits, maxToolCalls: 5 })
  assert.match(out, /5 tool calls/)
})
