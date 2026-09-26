import { test } from "node:test"
import assert from "node:assert/strict"

import { buildCogniaToolsServer, wrapNativeToolResults } from "./sdk-mcp.ts"
import type { CallableTool } from "../../../test-support/tool-result.ts"

test("buildCogniaToolsServer returns null when no categories enabled", () => {
  assert.equal(buildCogniaToolsServer({ enabled: {} }), null)
  assert.equal(
    buildCogniaToolsServer({
      enabled: {
        fileExtras: false,
        git: false,
        process: false,
        environment: false,
        shellAdvanced: false,
        terminalRepl: false,
      },
    }),
    null
  )
})

test("buildCogniaToolsServer returns null when enabled is undefined", () => {
  assert.equal(buildCogniaToolsServer({ enabled: undefined }), null)
})

test("buildCogniaToolsServer returns a config when at least one category enabled", () => {
  const server = buildCogniaToolsServer({ enabled: { git: true } })
  assert.notEqual(server, null)
  // Shape sniff — SDK returns { name, instance, type:'sdk' } in some versions.
  assert.equal(server?.name, "cognia-tools")
})

test("buildCogniaToolsServer composes tools from all enabled categories", () => {
  const all = buildCogniaToolsServer({
    enabled: {
      fileExtras: true,
      git: true,
      process: true,
      environment: true,
      shellAdvanced: true,
      terminalRepl: true,
    },
  })
  assert.notEqual(all, null)
  // The instance method `getTools()` (or similar) isn't always exposed; we
  // just verify object construction didn't throw and that name is right.
  assert.equal(all?.name, "cognia-tools")
})

test("buildCogniaToolsServer accepts a per-tool timeout (incl. 0 to disable)", () => {
  // The read-only deadline wrapping is exercised in read-only-timeout.test.ts;
  // here we just lock that the param threads through construction on both the
  // default-net and disabled paths.
  const explicit = buildCogniaToolsServer({ enabled: { git: true }, toolExecutionTimeoutMs: 5000 })
  assert.equal(explicit?.name, "cognia-tools")
  const disabled = buildCogniaToolsServer({ enabled: { git: true }, toolExecutionTimeoutMs: 0 })
  assert.equal(disabled?.name, "cognia-tools")
})

test("buildCogniaToolsServer returns null when nothing enabled, a server otherwise", () => {
  assert.equal(buildCogniaToolsServer({ enabled: {} }), null)
  assert.ok(buildCogniaToolsServer({ enabled: { git: true } }))
})

test("native MCP tool output uses the provider PII gate", async () => {
  const [tool] = wrapNativeToolResults([
    {
      name: "read",
      handler: async () => ({ content: [{ type: "text", text: "Email: alice@example.com" }] }),
    },
  ]) as unknown as CallableTool[]
  const result = await tool!.handler({})
  assert.equal(JSON.stringify(result).includes("alice@example.com"), false)
})
