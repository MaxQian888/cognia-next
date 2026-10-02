#!/usr/bin/env node
// Fixture MCP server (stdio) for the managed Pro IDE's real-binary E2E.
//
// One tool, `fixture_echo`, which echoes its text argument. The platform wraps
// a stdio MCP server in a loopback HTTP relay; the E2E lists tools through that
// relay, so a name coming back proves process supervision and the relay both
// work. Newline-delimited JSON-RPC, as MCP's stdio transport specifies.

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)

// No imports: the platform copies this file into a cache without its
// extension, where an `import` would hinge on Node's module-type detection.
let pending = ""
process.stdin.on("data", (chunk) => {
  pending += chunk.toString("utf8")
  let newline
  while ((newline = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})

function handle(message) {
  if (message.id === undefined) return
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "cognia-fixture-mcp", version: "1.0.0" },
      },
    })
  } else if (message.method === "tools/list") {
    send({
      id: message.id,
      result: {
        tools: [
          {
            name: "fixture_echo",
            description: "Echo the given text back.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      },
    })
  } else if (message.method === "tools/call") {
    send({
      id: message.id,
      result: {
        content: [{ type: "text", text: `echo: ${message.params?.arguments?.text ?? ""}` }],
      },
    })
  } else {
    send({ id: message.id, error: { code: -32601, message: `unhandled ${message.method}` } })
  }
}
