import test from "node:test"
import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import { runA2uiStdio } from "./a2ui-stdio.ts"

test("standalone protocol preserves negotiation, detached results and parse recovery", async () => {
  const input = new PassThrough()
  const lines: string[] = []
  const errors: string[] = []
  const server = runA2uiStdio({
    input,
    output: { write: (line) => lines.push(line) },
    errorOutput: { write: (line) => errors.push(line) },
    env: {},
  })
  try {
    input.write("not JSON\nnull\n")
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    })
    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "a2ui_create_surface", arguments: { surfaceId: "s", surfaceType: "inline" } },
    })
    await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "unknown" },
    })
    const replies = lines.map((line) => JSON.parse(line))
    assert.equal(replies[0].result.protocolVersion, "2024-11-05")
    assert.deepEqual(JSON.parse(replies[1].result.content[0].text), {
      ok: true,
      surfaceId: "s",
      dispatched: false,
      note: "running detached; no UI dispatch",
    })
    assert.equal(replies[2].error.code, -32601)
    assert.ok(errors.some((message) => message.includes("bad JSON")))
  } finally {
    server.close()
    input.destroy()
  }
})
