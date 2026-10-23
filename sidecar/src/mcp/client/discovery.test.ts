import type { MCPClientConfig } from "@ai-sdk/mcp"
import test from "node:test"
import assert from "node:assert/strict"

import { discoverMcpServer } from "./discovery.ts"

test("discovers normalized capabilities and guarantees teardown", async () => {
  const calls: string[] = []
  const guard = {
    fetch: async () => new Response(),
    close: async () => {
      calls.push("guard.close")
    },
  }
  const client = {
    listTools: async () => ({
      tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
    }),
    listResources: async () => ({ resources: [{ uri: "docs://root", name: "Docs" }] }),
    experimental_listPrompts: async () => ({ prompts: [{ name: "review" }] }),
    close: async () => calls.push("client.close"),
  }
  let clientConfig!: MCPClientConfig

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

  assert.ok("url" in clientConfig.transport)
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
      StdioTransport: class StdioTransport {
        async start() {}
        async send() {}
        async close() {}
      },
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

const stdioServer = { transport: "stdio", config: { command: "fixture" } }
class NoopStdioTransport {
  async start() {}
  async send() {}
  async close() {}
}

function undeclared(capability: string) {
  return async () => {
    throw new Error(`Server does not support ${capability}`)
  }
}

test("discovers each legitimate capability subset without a false failure", async () => {
  const subsets = [
    { capabilities: { tools: {} }, expect: [1, 0, 0] },
    { capabilities: { resources: {} }, expect: [0, 1, 0] },
    { capabilities: { prompts: {} }, expect: [0, 0, 1] },
  ]
  for (const subset of subsets) {
    const called: string[] = []
    const result = await discoverMcpServer(stdioServer, {
      StdioTransport: NoopStdioTransport,
      createClient: async () => ({
        initializeResult: { capabilities: subset.capabilities },
        listTools: async () => {
          called.push("tools")
          if (!("tools" in subset.capabilities)) throw new Error("Server does not support tools")
          return { tools: [{ name: "search" }] }
        },
        listResources: async () => {
          called.push("resources")
          if (!("resources" in subset.capabilities)) {
            throw new Error("Server does not support resources")
          }
          return { resources: [{ uri: "docs://root" }] }
        },
        experimental_listPrompts: async () => {
          called.push("prompts")
          if (!("prompts" in subset.capabilities))
            throw new Error("Server does not support prompts")
          return { prompts: [{ name: "review" }] }
        },
        close: async () => undefined,
      }),
    })
    assert.equal(result.ok, true)
    assert.deepEqual(
      [result.tools.length, result.resources.length, result.prompts.length],
      subset.expect
    )
    // Undeclared capabilities are never requested.
    assert.deepEqual(called, Object.keys(subset.capabilities))
  }
})

test("treats the SDK's local undeclared-capability rejection as empty when capabilities are unknown", async () => {
  const result = await discoverMcpServer(stdioServer, {
    StdioTransport: NoopStdioTransport,
    createClient: async () => ({
      listTools: async () => ({ tools: [{ name: "search" }] }),
      listResources: undeclared("resources"),
      experimental_listPrompts: undeclared("prompts"),
      close: async () => undefined,
    }),
  })
  assert.deepEqual(result.tools, [{ name: "search" }])
  assert.deepEqual(result.resources, [])
  assert.deepEqual(result.prompts, [])
})

test("keeps real failures of a declared capability", async () => {
  await assert.rejects(
    discoverMcpServer(stdioServer, {
      StdioTransport: NoopStdioTransport,
      createClient: async () => ({
        initializeResult: { capabilities: { tools: {}, resources: {} } },
        listTools: async () => ({ tools: [] }),
        listResources: async () => {
          throw new Error("connection reset")
        },
        experimental_listPrompts: undeclared("prompts"),
        close: async () => undefined,
      }),
    }),
    /connection reset/
  )
})

test("follows nextCursor through every page of each list", async () => {
  const cursors: Record<string, unknown[]> = { tools: [], resources: [], prompts: [] }
  const result = await discoverMcpServer(stdioServer, {
    StdioTransport: NoopStdioTransport,
    createClient: async () => ({
      initializeResult: { capabilities: { tools: {}, resources: {}, prompts: {} } },
      listTools: async ({ params }) => {
        cursors.tools!.push(params?.cursor)
        return params?.cursor === undefined
          ? { tools: [{ name: "a" }], nextCursor: "t2" }
          : params.cursor === "t2"
            ? { tools: [], nextCursor: "t3" }
            : { tools: [{ name: "b" }] }
      },
      listResources: async ({ params }) => {
        cursors.resources!.push(params?.cursor)
        return params?.cursor === undefined
          ? { resources: [{ uri: "r://1" }], nextCursor: "r2" }
          : { resources: [{ uri: "r://2" }] }
      },
      experimental_listPrompts: async ({ params }) => {
        cursors.prompts!.push(params?.cursor)
        return params?.cursor === undefined
          ? { prompts: [{ name: "p1" }], nextCursor: "p2" }
          : { prompts: [{ name: "p2" }] }
      },
      close: async () => undefined,
    }),
  })
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ["a", "b"]
  )
  assert.equal(result.toolCount, 2)
  assert.deepEqual(
    result.resources.map((resource) => resource.uri),
    ["r://1", "r://2"]
  )
  assert.deepEqual(
    result.prompts.map((prompt) => prompt.name),
    ["p1", "p2"]
  )
  assert.deepEqual(cursors, {
    tools: [undefined, "t2", "t3"],
    resources: [undefined, "r2"],
    prompts: [undefined, "p2"],
  })
})

test("fails instead of looping on a repeated cursor", async () => {
  await assert.rejects(
    discoverMcpServer(stdioServer, {
      StdioTransport: NoopStdioTransport,
      createClient: async () => ({
        initializeResult: { capabilities: { tools: {} } },
        listTools: async () => ({ tools: [{ name: "a" }], nextCursor: "same" }),
        listResources: undeclared("resources"),
        experimental_listPrompts: undeclared("prompts"),
        close: async () => undefined,
      }),
    }),
    /repeated cursor/
  )
})

test("preserves the metadata downstream consumers read", async () => {
  const appMeta = { ui: { resourceUri: "ui://widget/card.html" } }
  const result = await discoverMcpServer(stdioServer, {
    StdioTransport: NoopStdioTransport,
    createClient: async () => ({
      initializeResult: { capabilities: { tools: {}, prompts: {} } },
      listTools: async () => ({
        tools: [
          {
            name: "show",
            inputSchema: { type: "object" },
            outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
            _meta: appMeta,
          },
        ],
      }),
      listResources: undeclared("resources"),
      experimental_listPrompts: async () => ({
        prompts: [
          {
            name: "review",
            arguments: [
              { name: "path", description: "File", required: true },
              { description: "nameless entries are dropped" },
            ],
          },
        ],
      }),
      close: async () => undefined,
    }),
  })
  assert.deepEqual(result.tools, [
    {
      name: "show",
      inputSchema: { type: "object" },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      _meta: appMeta,
    },
  ])
  assert.deepEqual(result.prompts, [
    { name: "review", arguments: [{ name: "path", description: "File", required: true }] },
  ])
})
