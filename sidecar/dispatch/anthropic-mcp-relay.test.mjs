import test from "node:test"
import assert from "node:assert/strict"

import { __TESTING__, guardAnthropicRemoteMcpServers } from "./anthropic-mcp-relay.mjs"

test("routes remote Anthropic MCP through a guarded stdio relay without argv secrets", () => {
  const servers = guardAnthropicRemoteMcpServers(
    {
      docs: {
        type: "http",
        url: "https://mcp.example/rpc",
        headers: { authorization: "Bearer secret" },
        timeout: 20_000,
        alwaysLoad: true,
      },
    },
    { nodeExecutable: "/node", scriptPath: "/sidecar/mcp-stdio-relay.mjs", packaged: false }
  )

  assert.deepEqual(servers.docs.args, ["/sidecar/mcp-stdio-relay.mjs"])
  assert.equal(servers.docs.command, "/node")
  assert.equal(servers.docs.type, "stdio")
  assert.equal(servers.docs.timeout, 20_000)
  assert.equal(servers.docs.alwaysLoad, true)
  assert.equal(JSON.stringify(servers.docs.args).includes("secret"), false)
  const decoded = JSON.parse(
    Buffer.from(servers.docs.env[__TESTING__.RELAY_CONFIG_ENV], "base64url").toString("utf8")
  )
  assert.deepEqual(decoded, {
    transport: "http",
    url: "https://mcp.example/rpc",
    headers: { authorization: "Bearer secret" },
    allowPrivateNetwork: false,
  })
})

test("preserves stdio servers and private-network review state", () => {
  const stdio = { type: "stdio", command: "npx", args: ["server"] }
  const result = guardAnthropicRemoteMcpServers(
    {
      local: stdio,
      intranet: {
        type: "sse",
        url: "http://10.0.0.2/sse",
        allowPrivateNetwork: true,
      },
    },
    { nodeExecutable: "/node", scriptPath: "/relay", packaged: false }
  )
  assert.equal(result.local, stdio)
  const decoded = JSON.parse(
    Buffer.from(result.intranet.env[__TESTING__.RELAY_CONFIG_ENV], "base64url").toString("utf8")
  )
  assert.equal(decoded.allowPrivateNetwork, true)
})

test("self-execs the packaged CLI binary in the dedicated relay role", () => {
  const result = guardAnthropicRemoteMcpServers(
    { docs: { type: "http", url: "https://mcp.example/rpc" } },
    {
      nodeExecutable: "/dist/cognia-agent",
      scriptPath: "/dist/sidecar/mcp-stdio-relay.mjs",
      packaged: true,
    }
  )
  assert.deepEqual(result.docs.args, [])
  assert.equal(result.docs.env.COGNIA_ROLE, "mcp-relay")
  assert.equal(result.docs.env.COGNIA_MCP_RELAY_SCRIPT, "/dist/sidecar/mcp-stdio-relay.mjs")
})
