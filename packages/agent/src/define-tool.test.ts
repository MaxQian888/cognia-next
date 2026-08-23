import * as v from "valibot"

import { defineRawTool, defineTool } from "./define-tool"
import { ToolSchemaError } from "./errors"

const context = {
  sessionId: "s1",
  runId: "r1",
  attemptId: "a1",
  invocationId: "i1",
}

const readFile = defineTool({
  name: "read_file",
  description: "Read a file",
  input: v.object({ path: v.pipe(v.string(), v.minLength(1)), lines: v.optional(v.number()) }),
  output: v.object({ contents: v.string() }),
  handler: async ({ path }) => ({ contents: `contents of ${path}` }),
})

describe("defineTool", () => {
  it("derives a JSON Schema contract from the valibot schema", () => {
    expect(readFile.reference).toMatchObject({
      name: "read_file",
      sideEffect: "none",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", minLength: 1 }, lines: { type: "number" } },
        required: ["path"],
      },
      outputSchema: { type: "object", properties: { contents: { type: "string" } } },
    })
    expect(readFile.reference.schemaDigest).toMatch(/^sha256-/)
  })

  it("derives the handler id from the contract digest", () => {
    expect(readFile.registration.handlerId).toBe(`read_file@${readFile.reference.schemaDigest}`)
  })

  it("gives an identical contract an identical digest", () => {
    const twin = defineTool({
      name: "read_file",
      description: "Read a file",
      input: v.object({ path: v.pipe(v.string(), v.minLength(1)), lines: v.optional(v.number()) }),
      output: v.object({ contents: v.string() }),
      handler: async () => ({ contents: "" }),
    })
    expect(twin.reference.schemaDigest).toBe(readFile.reference.schemaDigest)
  })

  it("changes the digest when the contract changes", () => {
    const widened = defineTool({
      name: "read_file",
      description: "Read a file",
      input: v.object({ path: v.string() }),
      handler: async () => ({ contents: "" }),
    })
    expect(widened.reference.schemaDigest).not.toBe(readFile.reference.schemaDigest)
  })

  it("validates input before the handler ever runs", async () => {
    const handler = jest.fn(async () => ({ contents: "" }))
    const tool = defineTool({
      name: "strict",
      description: "d",
      input: v.object({ path: v.string() }),
      handler,
    })
    await expect(tool.invoke({ path: 7 }, context)).rejects.toBeInstanceOf(ToolSchemaError)
    expect(handler).not.toHaveBeenCalled()
  })

  it("reports the offending field on an input failure", async () => {
    await expect(readFile.invoke({ path: "" }, context)).rejects.toMatchObject({
      code: "schema_mismatch",
      toolName: "read_file",
      issues: [expect.stringContaining("path")],
    })
  })

  it("validates the handler's output too", async () => {
    const tool = defineTool({
      name: "liar",
      description: "d",
      input: v.object({}),
      output: v.object({ contents: v.string() }),
      handler: async () => ({ contents: 42 }) as never,
    })
    await expect(tool.invoke({}, context)).rejects.toMatchObject({
      code: "output_invalid",
      toolName: "liar",
    })
  })

  it("returns the parsed output on the happy path", async () => {
    await expect(readFile.invoke({ path: "/tmp/a" }, context)).resolves.toEqual({
      contents: "contents of /tmp/a",
    })
  })

  it("skips output validation when no output schema is declared", async () => {
    const tool = defineTool({
      name: "loose",
      description: "d",
      input: v.object({}),
      handler: async () => ({ anything: true }),
    })
    await expect(tool.invoke({}, context)).resolves.toEqual({ anything: true })
    expect(tool.reference.outputSchema).toBeUndefined()
  })

  it("defaults to a no-side-effect tool and carries a declared one", () => {
    expect(readFile.reference.sideEffect).toBe("none")
    const writer = defineTool({
      name: "write_file",
      description: "d",
      input: v.object({}),
      sideEffect: "non-idempotent",
      handler: async () => undefined,
    })
    expect(writer.reference.sideEffect).toBe("non-idempotent")
    expect(writer.registration.sideEffect).toBe("non-idempotent")
  })

  it("passes the invocation context through to the handler", async () => {
    const seen: unknown[] = []
    const tool = defineTool({
      name: "ctx",
      description: "d",
      input: v.object({}),
      handler: async (_input, invocation) => {
        seen.push(invocation)
        return null
      },
    })
    await tool.invoke({}, context)
    expect(seen).toEqual([context])
  })

  it("carries an optional timeout onto the registration only when given", () => {
    expect(readFile.registration.timeoutMs).toBeUndefined()
    const slow = defineTool({
      name: "slow",
      description: "d",
      input: v.object({}),
      timeoutMs: 5_000,
      handler: async () => null,
    })
    expect(slow.registration.timeoutMs).toBe(5_000)
  })
})

describe("defineRawTool", () => {
  it("accepts a hand-written JSON Schema and types the input as unknown", async () => {
    const tool = defineRawTool({
      name: "raw",
      description: "d",
      inputSchema: { type: "object", properties: { when: { type: "string", format: "date" } } },
      handler: async (input) => input,
    })
    expect(tool.reference.inputSchema).toMatchObject({ type: "object" })
    expect(tool.reference.schemaDigest).toMatch(/^sha256-/)
    // No conversion, so no client-side validation to bypass.
    await expect(tool.invoke({ anything: 1 }, context)).resolves.toEqual({ anything: 1 })
  })

  it("still derives its handler id from the contract", () => {
    const tool = defineRawTool({
      name: "raw",
      description: "d",
      inputSchema: { type: "object" },
      handler: async () => null,
    })
    expect(tool.registration.handlerId).toBe(`raw@${tool.reference.schemaDigest}`)
  })
})
