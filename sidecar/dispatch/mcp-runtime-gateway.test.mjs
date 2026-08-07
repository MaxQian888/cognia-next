import test from "node:test"
import assert from "node:assert/strict"

import { discoverMcpServer } from "./mcp-runtime-gateway.mjs"

test("discovers normalized capabilities and guarantees teardown", async () => {
  const calls = []
  const guard = { fetch: async () => new Response(), close: async () => calls.push("guard.close") }
  const client = {
    listTools: async () => ({
      tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
    }),
    listResources: async () => ({ resources: [{ uri: "docs://root", name: "Docs" }] }),
    experimental_listPrompts: async () => ({ prompts: [{ name: "review" }] }),
    close: async () => calls.push("client.close"),
  }
  let clientConfig

  const result = await discoverMcpServer(
    {
      transport: "http",
      config: { url: "https://mcp.example/rpc", headers: { authorization: "ephemeral" } },
    },
    {
      createEgressGuard: () => guard,
      createClient: async (config) => {
        clientConfig = config
        return client
      },
    }
  )

  assert.equal(clientConfig.transport.redirect, "error")
  assert.equal(clientConfig.transport.fetch, guard.fetch)
  assert.deepEqual(result.tools, [
    { name: "search", description: "Search", inputSchema: { type: "object" } },
  ])
  assert.deepEqual(result.resources, [{ uri: "docs://root", name: "Docs" }])
  assert.deepEqual(result.prompts, [{ name: "review" }])
  assert.deepEqual(calls, ["client.close", "guard.close"])
})

test("treats unsupported optional capability lists as empty", async () => {
  const methodNotFound = Object.assign(new Error("Method not found"), { code: -32601 })
  const result = await discoverMcpServer(
    { transport: "stdio", config: { command: "fixture" } },
    {
      StdioTransport: class StdioTransport {},
      createClient: async () => ({
        listTools: async () => ({ tools: [] }),
        listResources: async () => {
          throw methodNotFound
        },
        experimental_listPrompts: async () => {
          throw methodNotFound
        },
        close: async () => undefined,
      }),
    }
  )

  assert.deepEqual(result.resources, [])
  assert.deepEqual(result.prompts, [])
})

test("closes the guarded dispatcher when connection fails", async () => {
  let closed = 0
  await assert.rejects(
    discoverMcpServer(
      { transport: "sse", config: { url: "https://mcp.example/sse" } },
      {
        createEgressGuard: () => ({
          fetch: async () => new Response(),
          close: async () => {
            closed += 1
          },
        }),
        createClient: async () => {
          throw new Error("offline")
        },
      }
    ),
    /offline/
  )
  assert.equal(closed, 1)
})

