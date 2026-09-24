import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import cogniaPiExtension, {
  createMcpProjection,
  piMcpResult,
  readMcpServers,
  __readPolicyForTests,
  __markerPayloadForTests,
} from "./cognia-pi-extension.ts"

function fakePi() {
  const tools = new Map<string, any>()
  const handlers = new Map<string, Array<(...args: any[]) => any>>()
  let active = ["read"]
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names
    },
    on: (event: string, handler: any) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  }
  const ctx = {
    cwd: "/workspace",
    hasUI: true,
    ui: {
      confirm: async (..._args: any[]) => true,
      input: async (..._args: any[]): Promise<string | undefined> => '{"choice":"yes"}',
      notify: (..._args: any[]) => {},
      setStatus: (..._args: any[]) => {},
    },
  }
  return { pi, tools, handlers, ctx }
}

async function fixture(
  t: any,
  behavior: {
    list?: (params: any) => any
    call?: (params: any, extra: any, server: Server) => any
  } = {}
) {
  const server = new Server(
    { name: "fixture", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } }
  )
  server.setRequestHandler(
    ListToolsRequestSchema,
    (request) =>
      behavior.list?.(request.params) ?? {
        tools: [
          {
            name: "echo",
            description: "Echo",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          },
        ],
      }
  )
  server.setRequestHandler(
    CallToolRequestSchema,
    (request, extra) =>
      behavior.call?.(request.params, extra, server) ?? {
        content: [{ type: "text", text: String(request.params.arguments?.text) }],
      }
  )
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID })
  await server.connect(transport)
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer fixture-secret") {
      res.writeHead(403).end()
      return
    }
    await transport.handleRequest(req, res)
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    await server.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })
  const port = (http.address() as { port: number }).port
  const config = {
    name: "custom",
    type: "http" as const,
    url: `http://127.0.0.1:${port}/mcp`,
    headers: [{ name: "Authorization", value: "Bearer fixture-secret" }],
  }
  const fake = fakePi()
  const projection = createMcpProjection(fake.pi, [config])
  t.after(() => projection.close())
  return { ...fake, projection, config, server }
}

test("validates current stdio, HTTP and SSE configuration without admitting channel transport", () => {
  assert.deepEqual(readMcpServers(undefined), [])
  assert.equal(
    readMcpServers(
      JSON.stringify([
        { name: "stdio", command: "node", args: [], env: [{ name: "TOKEN", value: "credential" }] },
        { name: "http", type: "http", url: "https://example.test/mcp" },
        { name: "sse", type: "sse", url: "http://localhost/sse" },
      ])
    ).length,
    3
  )
  for (const value of [
    {},
    [null],
    [{ name: "bad space" }],
    [{ name: "a", type: "acp" }],
    [{ name: "a", command: "node", args: [1] }],
    [{ name: "a", type: "http", url: "file:///tmp/a" }],
    [{ name: "a", type: "http", url: "https://user:pass@example.test" }],
    [{ name: "a", command: "node", args: [], env: [{}] }],
    [
      { name: "a", command: "node", args: [] },
      { name: "a", command: "node", args: [] },
    ],
  ]) {
    assert.throws(() => readMcpServers(JSON.stringify(value)))
  }
})

test("preserves images, text resources and structured output while redacting model-bound text", () => {
  const result = piMcpResult({
    content: [
      { type: "text", text: "contact alice@example.com" },
      { type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
      { type: "resource", resource: { text: "resource text" } },
      {
        type: "resource",
        resource: { mimeType: "text/plain", blob: Buffer.from("decoded text").toString("base64") },
      },
      { type: "resource_link", uri: "https://example.test/resource", name: "document" },
    ],
    structuredContent: { summary: "finished" },
  })
  assert.equal(result.content.length, 6)
  assert.ok(!JSON.stringify(result).includes("alice@example.com"))
  assert.deepEqual(result.content[1], { type: "image", mimeType: "image/png", data: "cGl4ZWxz" })
  assert.match(JSON.stringify(result.content), /decoded text/)
  for (const block of [
    { type: "audio" },
    { type: "resource", resource: { blob: "AA==", mimeType: "application/octet-stream" } },
  ])
    assert.throws(() => piMcpResult({ content: [block] }), /cannot represent/)
  assert.throws(
    () => piMcpResult({ isError: true, content: [{ type: "text", text: "refused" }] }),
    /refused/
  )
  assert.throws(() => piMcpResult({ isError: true }), /MCP tool failed/)
})

test("real HTTP discovery and execution update the active catalog each turn", async (t) => {
  let toolName = "echo"
  const f = await fixture(t, {
    list: () => ({ tools: [{ name: toolName, inputSchema: { type: "object" } }] }),
  })
  await f.projection.start(f.ctx)
  assert.deepEqual(f.pi.getActiveTools(), ["read", "mcp__custom__echo"])
  const old = f.tools.get("mcp__custom__echo")
  assert.deepEqual(await old.execute("call", { text: "hello" }, new AbortController().signal), {
    content: [{ type: "text", text: "hello" }],
    details: {},
  })
  toolName = "next"
  await Promise.all([f.projection.refresh(), f.projection.refresh(f.ctx)])
  assert.deepEqual(f.pi.getActiveTools(), ["read", "mcp__custom__next"])
  await assert.rejects(old.execute("late", {}, new AbortController().signal), /no longer available/)
  await f.projection.close()
  await assert.rejects(
    f.tools.get("mcp__custom__next").execute("late", {}, new AbortController().signal),
    /no longer available/
  )
})

test("rejects a PII-bearing or malformed catalog before registering any tool", async (t) => {
  for (const tool of [{ name: "echo", description: "alice@example.com" }, { name: "bad/name" }]) {
    const f = await fixture(t, {
      list: () => ({ tools: [{ ...tool, inputSchema: { type: "object" } }] }),
    })
    await assert.rejects(f.projection.start(f.ctx), /PII gate|Invalid/)
    assert.equal(f.tools.size, 0)
  }
})

test("rejects repeated pagination and duplicate tools", async (t) => {
  for (const response of [
    { tools: [], nextCursor: "loop" },
    {
      tools: [
        { name: "echo", inputSchema: { type: "object" } },
        { name: "echo", inputSchema: { type: "object" } },
      ],
    },
  ]) {
    const f = await fixture(t, { list: () => response })
    await assert.rejects(f.projection.start(f.ctx), /repeating cursor|duplicate/)
  }
})

test("advertises dotted tool names sanitized while dispatching the real MCP name", async (t) => {
  const calls: string[] = []
  const f = await fixture(t, {
    list: () => ({
      tools: [
        {
          name: "ocr.extract",
          description: "OCR",
          inputSchema: { type: "object", properties: { source: { type: "string" } } },
        },
      ],
    }),
    call: (params) => {
      calls.push(params.name)
      return { content: [{ type: "text", text: "done" }] }
    },
  })
  await f.projection.start(f.ctx)
  assert.equal(f.tools.has("mcp__custom__ocr.extract"), false)
  assert.ok(f.tools.has("mcp__custom__ocr_extract"))
  assert.ok(f.projection.owns("mcp__custom__ocr_extract"))
  assert.deepEqual(f.pi.getActiveTools(), ["read", "mcp__custom__ocr_extract"])
  assert.deepEqual(
    await f.tools
      .get("mcp__custom__ocr_extract")
      .execute("call", { source: "x" }, new AbortController().signal),
    { content: [{ type: "text", text: "done" }], details: {} }
  )
  assert.deepEqual(calls, ["ocr.extract"])
})

test("advertises colon-namespaced plugin tool names sanitized while dispatching the real MCP name", async (t) => {
  const calls: string[] = []
  const f = await fixture(t, {
    list: () => ({
      tools: [
        {
          name: "ripgrep-tools:ripgrep_search",
          description: "Plugin tool",
          inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
        },
      ],
    }),
    call: (params) => {
      calls.push(params.name)
      return { content: [{ type: "text", text: "done" }] }
    },
  })
  await f.projection.start(f.ctx)
  assert.equal(f.tools.has("mcp__custom__ripgrep-tools:ripgrep_search"), false)
  assert.ok(f.tools.has("mcp__custom__ripgrep-tools_ripgrep_search"))
  assert.ok(f.projection.owns("mcp__custom__ripgrep-tools_ripgrep_search"))
  assert.deepEqual(
    await f.tools
      .get("mcp__custom__ripgrep-tools_ripgrep_search")
      .execute("call", { pattern: "x" }, new AbortController().signal),
    { content: [{ type: "text", text: "done" }], details: {} }
  )
  assert.deepEqual(calls, ["ripgrep-tools:ripgrep_search"])
})

test("rejects tool names that collide once sanitized for the provider", async (t) => {
  const f = await fixture(t, {
    list: () => ({
      tools: [
        { name: "a.b", inputSchema: { type: "object" } },
        { name: "a_b", inputSchema: { type: "object" } },
      ],
    }),
  })
  await assert.rejects(f.projection.start(f.ctx), /Invalid or duplicate MCP tool name/)
  assert.equal(f.tools.size, 0)
})

test("remote errors are actual Pi tool failures and cannot disclose server credentials", async (t) => {
  const f = await fixture(t, {
    call: () => {
      throw new Error("failed Bearer fixture-secret alice@example.com")
    },
  })
  await f.projection.start(f.ctx)
  await assert.rejects(
    f.tools.get("mcp__custom__echo").execute("call", {}, new AbortController().signal),
    (error: Error) => {
      assert.ok(!error.message.includes("fixture-secret"))
      assert.ok(!error.message.includes("alice@example.com"))
      return true
    }
  )
})

test("successful outputs and progress redact exact server credentials before Pi sees them", async (t) => {
  const f = await fixture(t, {
    call: async (params, extra, server) => {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: params._meta.progressToken,
          progress: 1,
          total: 2,
          message: "fixture-secret",
        },
      })
      return { content: [{ type: "text", text: "Bearer fixture-secret" }] }
    },
  })
  await f.projection.start(f.ctx)
  const updates: unknown[] = []
  const result = await f.tools
    .get("mcp__custom__echo")
    .execute("call", {}, new AbortController().signal, (update: unknown) => updates.push(update))
  assert.ok(updates.length > 0)
  assert.ok(!JSON.stringify({ result, updates }).includes("fixture-secret"))
  assert.ok(
    !JSON.stringify(
      f.projection.result({ content: [{ type: "text", text: "fixture-secret" }] })
    ).includes("fixture-secret")
  )
})

test("starts a real stdio MCP child and closes it with its owning Pi session", async (t) => {
  const f = fakePi()
  const program = `
    import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
    import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
    import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};
    const server = new Server({name:'fixture',version:'1'}, {capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[{name:'pid',inputSchema:{type:'object'}}]}));
    server.setRequestHandler(CallToolRequestSchema,()=>({content:[{type:'text',text:String(process.pid)}]}));
    await server.connect(new StdioServerTransport());`
  const projection = createMcpProjection(f.pi, [
    {
      name: "stdio",
      command: process.execPath,
      args: ["--input-type=module", "-e", program],
      env: [],
    },
  ])
  t.after(() => projection.close())
  await projection.start({ ...f.ctx, cwd: process.cwd() })
  const result = await f.tools
    .get("mcp__stdio__pid")
    .execute("call", {}, new AbortController().signal)
  const pid = Number(result.content[0].text)
  process.kill(pid, 0)
  await projection.close()
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
})

test("mounts an existing SSE server using the official transport", async (t) => {
  const f = fakePi()
  const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: "echo", inputSchema: { type: "object" } }],
  }))
  server.setRequestHandler(CallToolRequestSchema, () => ({
    content: [{ type: "text", text: "SSE works" }],
  }))
  let transport: SSEServerTransport
  const http = createServer(async (req, res) => {
    if (req.method === "GET") {
      transport = new SSEServerTransport("/messages", res)
      await server.connect(transport)
    } else await transport.handlePostMessage(req, res)
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    await server.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })
  const projection = createMcpProjection(f.pi, [
    {
      name: "sse",
      type: "sse",
      url: `http://127.0.0.1:${(http.address() as { port: number }).port}/sse`,
    },
  ])
  t.after(() => projection.close())
  await projection.start(f.ctx)
  assert.equal(
    (await f.tools.get("mcp__sse__echo").execute("call", {}, new AbortController().signal))
      .content[0].text,
    "SSE works"
  )
})

test("URL elicitation maps explicit accept, decline and cancellation", async (t) => {
  const f = await fixture(t, {
    call: async (_params, _extra, server) => {
      const response = await server.elicitInput({
        mode: "url",
        message: "Authorize",
        elicitationId: "auth",
        url: "https://example.test/auth",
      })
      return { content: [{ type: "text", text: response.action }] }
    },
  })
  await f.projection.start(f.ctx)
  const tool = f.tools.get("mcp__custom__echo")
  assert.equal(
    (await tool.execute("yes", {}, new AbortController().signal)).content[0].text,
    "accept"
  )
  f.ctx.ui.confirm = async () => false
  assert.equal(
    (await tool.execute("no", {}, new AbortController().signal)).content[0].text,
    "decline"
  )
})

test("native policy remains fail-closed, serialized, and cancellable alongside projected tools", async () => {
  for (const policy of [undefined, "broken", "null", "{}"])
    assert.equal(__readPolicyForTests(policy).fallback, "deny")
  assert.equal(
    __readPolicyForTests('{"decisions":{"read":"invalid"},"fallback":"ask"}').fallback,
    "ask"
  )
  assert.deepEqual(__markerPayloadForTests("bash", "plan", undefined), {
    tool: "bash",
    mode: "plan",
  })
  assert.deepEqual(__markerPayloadForTests("bash", "plan", { command: "x".repeat(20000) }), {
    tool: "bash",
    mode: "plan",
  })
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.deepEqual(__markerPayloadForTests("bash", "plan", cyclic), { tool: "bash", mode: "plan" })
  const saved = { ...process.env }
  process.env.COGNIA_TOOLHOST_PI_POLICY = JSON.stringify({
    mode: "custom",
    decisions: { read: "allow", write: "deny", bash: "ask" },
    fallback: "deny",
  })
  process.env.COGNIA_TOOLHOST_PI_SYSTEM_PROMPT = "Cognia instructions"
  process.env.COGNIA_TOOLHOST_PI_MCP_SERVERS = "[]"
  const f = fakePi()
  try {
    cogniaPiExtension(f.pi)
  } finally {
    for (const key of [
      "COGNIA_TOOLHOST_PI_POLICY",
      "COGNIA_TOOLHOST_PI_SYSTEM_PROMPT",
      "COGNIA_TOOLHOST_PI_MCP_SERVERS",
    ]) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
  assert.match(
    f.handlers.get("before_agent_start")![0]({ systemPrompt: "Pi" }, f.ctx).systemPrompt,
    /Pi\n\nCognia instructions/
  )
  const call = f.handlers.get("tool_call")![0]
  assert.equal(await call({ toolName: "read" }, f.ctx), undefined)
  assert.equal((await call({ toolName: "write" }, f.ctx)).block, true)
  assert.equal(await call({ toolName: "bash", input: { command: "pwd" } }, f.ctx), undefined)
  f.ctx.ui.confirm = async () => false
  assert.equal((await call({ toolName: "bash", input: {} }, f.ctx)).block, true)
  f.ctx.ui.confirm = async () => {
    throw new Error("UI unavailable")
  }
  assert.match((await call({ toolName: "bash" }, f.ctx)).reason, /permission check failed/)
  assert.equal((await call({ toolName: "bash" }, { ...f.ctx, hasUI: false })).block, true)
  assert.equal(
    (await call({ toolName: "read" }, { ...f.ctx, signal: AbortSignal.abort() })).block,
    true
  )
  let release!: (value: boolean) => void
  f.ctx.ui.confirm = async () =>
    new Promise((resolve) => {
      release = resolve
    })
  const pending = call({ toolName: "bash", input: { path: "/work" } }, f.ctx)
  await delay(0)
  let readRan = false
  const reading = call({ toolName: "read" }, f.ctx).then(() => {
    readRan = true
  })
  await delay(0)
  assert.equal(readRan, false)
  release(true)
  await Promise.all([pending, reading])
})

test("Pi cancellation aborts the official MCP request promptly", async (t) => {
  let called = false
  const f = await fixture(t, {
    call: async (_params, extra) => {
      called = true
      await delay(100, undefined, { signal: extra.signal }).catch(() => {})
      return { content: [{ type: "text", text: "too late" }] }
    },
  })
  await f.projection.start(f.ctx)
  const controller = new AbortController()
  const executing = f.tools.get("mcp__custom__echo").execute("call", {}, controller.signal)
  const rejected = assert.rejects(executing, /cancel|abort/i)
  while (!called) await delay(1)
  controller.abort(new Error("call cancelled"))
  await rejected
})

test("elicitation form validates user input and workspace roots are scoped", async (t) => {
  const f = await fixture(t, {
    call: async (_params, _extra, server) => {
      const roots = await server.listRoots()
      const response = await server.elicitInput({
        mode: "form",
        message: "Choose",
        requestedSchema: {
          type: "object",
          properties: { choice: { type: "string", enum: ["yes"] } },
          required: ["choice"],
        },
      })
      return { content: [{ type: "text", text: JSON.stringify({ roots, response }) }] }
    },
  })
  await f.projection.start(f.ctx)
  const tool = f.tools.get("mcp__custom__echo")
  const result = await tool.execute("call", {}, new AbortController().signal)
  assert.match(result.content[0].text, /file:\/\/\/workspace/)
  assert.match(result.content[0].text, /"choice":"yes"/)
  f.ctx.ui.input = async () => '{"choice":"no"}'
  await assert.rejects(
    tool.execute("invalid", {}, new AbortController().signal),
    /requested schema/
  )
  f.ctx.hasUI = false
  assert.match(
    (await tool.execute("headless", {}, new AbortController().signal)).content[0].text,
    /cancel/
  )
})

test("native Pi results pass the same PII gate and lifecycle announces only after startup", async () => {
  const f = fakePi()
  const before = process.env.COGNIA_TOOLHOST_PI_MCP_SERVERS
  process.env.COGNIA_TOOLHOST_PI_MCP_SERVERS = "[]"
  try {
    cogniaPiExtension(f.pi)
  } finally {
    if (before === undefined) delete process.env.COGNIA_TOOLHOST_PI_MCP_SERVERS
    else process.env.COGNIA_TOOLHOST_PI_MCP_SERVERS = before
  }
  const result = await f.handlers.get("tool_result")![0](
    { content: [{ type: "text", text: "alice@example.com" }], isError: false },
    f.ctx
  )
  assert.ok(!JSON.stringify(result).includes("alice@example.com"))
  assert.equal(
    (await f.handlers.get("tool_result")![0]({ content: [{ type: "audio" }] }, f.ctx)).isError,
    true
  )
  let status = ""
  f.ctx.ui.setStatus = (_key, text) => {
    status = text
  }
  await f.handlers.get("session_start")![0]({}, f.ctx)
  assert.match(status, /cognia-ready v2/)
  await f.handlers.get("before_agent_start")!.at(-1)!({}, f.ctx)
  await f.handlers.get("session_shutdown")![0]({}, f.ctx)
})

test("catalog notifications update tools and report invalid updates without leaking credentials", async (t) => {
  let name = "echo"
  const f = await fixture(t, {
    list: () => ({ tools: [{ name, title: "Friendly tool", inputSchema: { type: "object" } }] }),
    call: async (_params, extra) => {
      await extra.sendNotification({ method: "notifications/tools/list_changed" })
      await delay(10)
      return { content: [{ type: "text", text: "catalog changed" }] }
    },
  })
  const notifications: string[] = []
  f.ctx.ui.notify = (message) => notifications.push(message)
  await f.projection.start(f.ctx)
  name = "updated"
  await f.tools.get("mcp__custom__echo").execute("change", {}, undefined)
  for (let i = 0; i < 100 && !f.tools.has("mcp__custom__updated"); i++) await delay(2)
  assert.ok(f.tools.has("mcp__custom__updated"))
  name = "Bearer fixture-secret"
  await f.tools.get("mcp__custom__updated").execute("change", {}, undefined)
  for (let i = 0; i < 100 && !notifications.length; i++) await delay(2)
  assert.ok(notifications.some((message) => message.includes("PII gate")))
  assert.ok(!notifications.join().includes("fixture-secret"))
})

test("form elicitation handles dismissals, missing UI input and PII safely", async (t) => {
  const f = await fixture(t, {
    call: async (_params, _extra, server) => {
      const response = await server.elicitInput({
        mode: "form",
        message: "Input",
        requestedSchema: { type: "object", properties: { choice: { type: "string" } } },
      })
      return { content: [{ type: "text", text: JSON.stringify(response) }] }
    },
  })
  await f.projection.start(f.ctx)
  const tool = f.tools.get("mcp__custom__echo")
  f.ctx.ui.input = async () => undefined
  assert.match((await tool.execute("cancel", {}, undefined)).content[0].text, /cancel/)
  f.ctx.ui.input = async () => '{"choice":"alice@example.com"}'
  await assert.rejects(tool.execute("pii", {}, undefined), /PII gate/)
  delete (f.ctx.ui as { input?: unknown }).input
  assert.match((await tool.execute("no-input", {}, undefined)).content[0].text, /cancel/)
})

test("projection startup cannot revive a session closed while it was preparing", async () => {
  const f = fakePi()
  const projection = createMcpProjection(f.pi, [])
  const starting = projection.start(f.ctx)
  const closing = projection.close()
  await assert.rejects(starting, /closed during startup/)
  await closing
})

test("projected tools delegate authorization to their broker rather than native policy", async (t) => {
  const f = await fixture(t)
  const saved = process.env.COGNIA_TOOLHOST_PI_MCP_SERVERS
  process.env.COGNIA_TOOLHOST_PI_MCP_SERVERS = JSON.stringify([f.config])
  try {
    cogniaPiExtension(f.pi)
  } finally {
    if (saved === undefined) delete process.env.COGNIA_TOOLHOST_PI_MCP_SERVERS
    else process.env.COGNIA_TOOLHOST_PI_MCP_SERVERS = saved
  }
  t.after(() => f.handlers.get("session_shutdown")![0]({}, f.ctx))
  await f.handlers.get("session_start")![0]({}, f.ctx)
  assert.equal(
    await f.handlers.get("tool_call")![0]({ toolName: "mcp__custom__echo" }, f.ctx),
    undefined
  )
})
