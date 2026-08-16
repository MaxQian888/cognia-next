import { test } from "node:test"
import assert from "node:assert/strict"

import { RUN_CODE_TOOL_NAME, codeModeToolDefs, createRunCodeTool } from "./index.mjs"

const SANDBOXED = () => ({ canSpawnProcess: true, strictSandbox: true, launcher: ["/usr/bin/env"] })
const UNSANDBOXED = () => ({ canSpawnProcess: true, strictSandbox: false, launcher: null })

/** Pull the text payload out of an MCP CallToolResult. */
function payload(result) {
  return JSON.parse(result.content[0].text)
}

test("exposes exactly one tool in Code presentation", () => {
  const defs = codeModeToolDefs({ callTool: async () => null, probe: SANDBOXED })
  assert.equal(defs.length, 1)
  assert.equal(defs[0].name, RUN_CODE_TOOL_NAME)
})

// Fail closed: there is no executor to reach at all on an unsandboxed host,
// rather than one that refuses per call.
test("exposes no tool at all when the host cannot sandbox", () => {
  assert.deepEqual(codeModeToolDefs({ callTool: async () => null, probe: UNSANDBOXED }), [])
})

test("runs a program and reports the calls it used", async () => {
  const tool = createRunCodeTool({
    callTool: async (name) => ({ tool: name }),
    probe: SANDBOXED,
  })
  const result = await tool.handler({ source: 'return await cognia.read({ path: "a" })' })
  assert.notEqual(result.isError, true)
  assert.deepEqual(payload(result).result, { tool: "read" })
  assert.equal(payload(result).callsUsed, 1)
})

test("reports a limit hit with the ceiling that was reached", async () => {
  const tool = createRunCodeTool({ callTool: async () => null, probe: SANDBOXED })
  const result = await tool.handler({ source: "x".repeat(40_000) })
  assert.equal(result.isError, true)
  assert.equal(payload(result).limit.kind, "source-too-large")
})

test("refuses with an explicit no-fallback message when unsandboxed", async () => {
  const tool = createRunCodeTool({ callTool: async () => null, probe: UNSANDBOXED })
  const result = await tool.handler({ source: "return 1" })
  assert.equal(result.isError, true)
  const text = result.content[0].text
  assert.match(text, /strict sandbox/)
  // The user-facing wording has to rule out the degraded path explicitly.
  assert.match(text, /no unsandboxed fallback/i)
})

test("treats a missing source as an empty program rather than throwing", async () => {
  const tool = createRunCodeTool({ callTool: async () => null, probe: SANDBOXED })
  const result = await tool.handler({})
  assert.notEqual(result.isError, true)
  assert.equal(payload(result).result, null)
})

test("surfaces program logs alongside the result", async () => {
  const tool = createRunCodeTool({ callTool: async () => null, probe: SANDBOXED })
  const result = await tool.handler({ source: 'console.log("hi"); return 1' })
  assert.deepEqual(payload(result).logs, [{ level: "info", text: "hi" }])
})
