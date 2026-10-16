import { test } from "node:test"
import assert from "node:assert/strict"

import { InvalidToolInputError, NoSuchToolError, streamText, tool } from "ai"
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test"
import { z } from "zod"

import {
  createToolCallRepair,
  renameAliasedArguments,
  resolveToolName,
  type RepairableToolCall,
} from "./ai-sdk-tool-call-repair.ts"

const readSchema = {
  type: "object",
  properties: { file_path: { type: "string" }, offset: { type: "number" } },
  required: ["file_path"],
  additionalProperties: false,
}

test("resolveToolName matches case and wrapper prefixes, never an ambiguous name", () => {
  assert.equal(resolveToolName("read", ["read", "write"]), "read")
  assert.equal(resolveToolName("Read", ["read", "write"]), "read")
  assert.equal(resolveToolName("functions.read", ["read"]), "read")
  assert.equal(resolveToolName("tools.Write", ["read", "write"]), "write")
  assert.equal(resolveToolName("edit", ["read", "write"]), null)
  assert.equal(resolveToolName("Grep", ["grep", "GREP"]), null)
})

test("renameAliasedArguments moves an alias onto the missing required property", () => {
  assert.deepEqual(renameAliasedArguments({ path: "notes.txt" }, readSchema), {
    file_path: "notes.txt",
  })
  assert.deepEqual(renameAliasedArguments({ filePath: "a", offset: 2 }, readSchema), {
    file_path: "a",
    offset: 2,
  })
  assert.deepEqual(
    renameAliasedArguments(
      { file_path: "a", old_str: "x", new_str: "y" },
      {
        type: "object",
        properties: { file_path: {}, old_string: {}, new_string: {} },
        required: ["file_path", "old_string", "new_string"],
      }
    ),
    { file_path: "a", old_string: "x", new_string: "y" }
  )
})

test("renameAliasedArguments leaves anything it cannot repair unambiguously", () => {
  // Already valid, or nothing that looks like the missing value.
  assert.equal(renameAliasedArguments({ file_path: "a" }, readSchema), null)
  assert.equal(renameAliasedArguments({ contents: "a" }, readSchema), null)
  // Two candidates for one property.
  assert.equal(renameAliasedArguments({ path: "a", file: "b" }, readSchema), null)
  // A declared property is never moved, even when it looks like an alias.
  assert.equal(
    renameAliasedArguments(
      { path: "dir" },
      { type: "object", properties: { path: {}, file_path: {} }, required: ["file_path"] }
    ),
    null
  )
  assert.equal(renameAliasedArguments(["a"], readSchema), null)
  assert.equal(renameAliasedArguments({ path: "a" }, { type: "object" }), null)
})

const call = (toolName: string, input: unknown): RepairableToolCall => ({
  type: "tool-call",
  toolCallId: "c1",
  toolName,
  input: typeof input === "string" ? input : JSON.stringify(input),
})

test("createToolCallRepair fixes a near-miss name and an aliased argument", async () => {
  const repair = createToolCallRepair()
  const tools = { read: {}, write: {} }
  const inputSchema = async () => readSchema
  assert.deepEqual(
    await repair({
      toolCall: call("Read", { file_path: "a" }),
      tools,
      inputSchema,
      error: new NoSuchToolError({ toolName: "Read", availableTools: ["read", "write"] }),
    }),
    call("read", { file_path: "a" })
  )
  assert.deepEqual(
    await repair({
      toolCall: call("read", { path: "notes.txt" }),
      tools,
      inputSchema,
      error: new InvalidToolInputError({ toolName: "read", toolInput: "{}", cause: null }),
    }),
    call("read", { file_path: "notes.txt" })
  )
})

test("createToolCallRepair fixes a misspelled tool's aliased arguments in the same pass", async () => {
  const repair = createToolCallRepair()
  assert.deepEqual(
    await repair({
      toolCall: call("Read", { path: "a" }),
      tools: { read: {} },
      inputSchema: async ({ toolName }) => (toolName === "read" ? readSchema : {}),
      error: new NoSuchToolError({ toolName: "Read" }),
    }),
    call("read", { file_path: "a" })
  )
})

test("createToolCallRepair gives up on unknown tools, bad JSON and other errors", async () => {
  const repair = createToolCallRepair()
  const tools = { read: {} }
  const inputSchema = async () => readSchema
  const invalid = new InvalidToolInputError({ toolName: "read", toolInput: "", cause: null })
  assert.equal(
    await repair({
      toolCall: call("edit", { file_path: "a" }),
      tools,
      inputSchema,
      error: new NoSuchToolError({ toolName: "edit" }),
    }),
    null
  )
  assert.equal(
    await repair({ toolCall: call("read", "{not json"), tools, inputSchema, error: invalid }),
    null
  )
  assert.equal(
    await repair({
      toolCall: call("read", { path: "a" }),
      tools,
      inputSchema: async () => {
        throw new Error("no schema")
      },
      error: invalid,
    }),
    null
  )
  assert.equal(
    await repair({
      toolCall: call("read", { path: "a" }),
      tools,
      inputSchema,
      error: new Error("x"),
    }),
    null
  )
})

test("streamText runs the repaired call instead of failing it", async () => {
  const seen: unknown[] = []
  let step = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      step += 1
      const chunks =
        step === 1
          ? [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "Read",
                input: '{"path":"notes.txt"}',
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ]
          : [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "done" },
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ]
      return { stream: convertArrayToReadableStream(chunks as never[]) }
    },
  })
  const result = streamText({
    model,
    prompt: "read notes",
    tools: {
      // The built-in tools' shape: a zod object that rejects a missing field.
      read: tool({
        inputSchema: z.object({ file_path: z.string(), offset: z.number().optional() }),
        execute: async (input) => {
          seen.push(input)
          return "contents"
        },
      }),
    },
    stopWhen: ({ steps }) => steps.length >= 2,
    repairToolCall: createToolCallRepair() as never,
  })
  const types: string[] = []
  for await (const part of result.stream ?? result.fullStream) types.push(part.type)
  // One model call carrying both mistakes: the wrong case and the other
  // agent's argument name.
  assert.deepEqual(seen, [{ file_path: "notes.txt" }])
  assert.ok(types.includes("tool-result"), types.join(","))
  assert.ok(!types.includes("tool-error"), types.join(","))
})
