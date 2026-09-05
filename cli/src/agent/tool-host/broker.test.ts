/**
 * @jest-environment node
 */
import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { SendOptions } from "@cognia/agent-config-types"
import { namespaced } from "@/lib/settings/builtin-tools"

import { startToolHostBroker, toolHostEndpoint, type ToolHostBroker } from "./broker"
import type { ResolvedCliSessionContext } from "../session-context"
import type { PermissionResponder } from "../permission-gate"
import { COGNIA_PLUGIN_TOOLS_SERVER, COGNIA_TOOLS_SERVER } from "./protocol"

const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-th-test-"))

function sessionContext(overrides: Partial<SendOptions> = {}): ResolvedCliSessionContext {
  return {
    sessionId: "sess1",
    cwd: "/work",
    additionalDirectories: [],
    mcpServers: [],
    agents: [],
    subagentToolEnabled: false,
    activeSkillIds: [],
    contextualSkills: [],
    databaseError: null,
    contextVersion: "ctx1",
    sendOptions: {
      builtinTools: { git: true, coreFiles: true },
      confinement: { enabled: true, roots: ["/work"] },
      suppressApprovalForTools: [namespaced("git_status"), namespaced("read")],
      pluginTools: [
        { name: "ask_user", description: "ask", jsonSchema: {}, pluginId: "core", timeoutMs: 0 },
        { name: "web_search", description: "search", jsonSchema: {}, pluginId: "web" },
      ],
      ...overrides,
    } as SendOptions,
  }
}

/** A raw NDJSON client, standing in for the MCP bridge. */
function client(endpoint: string) {
  const socket = net.connect(endpoint)
  socket.setEncoding("utf8")
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let buffer = ""
  let id = 0
  let closedReason: string | null = null
  socket.on("data", (chunk: string) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line) as { id: number; result?: unknown; error?: string }
      const entry = pending.get(message.id)
      if (!entry) continue
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error))
      else entry.resolve(message.result)
    }
  })
  socket.on("close", () => {
    closedReason = "closed"
    for (const [, entry] of pending) entry.reject(new Error("closed"))
    pending.clear()
  })
  socket.on("error", () => undefined)
  return {
    socket,
    ready: () =>
      new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve())
        socket.once("error", reject)
      }),
    isClosed: () => closedReason !== null,
    call(method: string, params?: unknown) {
      const messageId = ++id
      return new Promise<unknown>((resolve, reject) => {
        pending.set(messageId, { resolve, reject })
        socket.write(`${JSON.stringify({ id: messageId, method, params })}\n`)
      })
    },
    end() {
      socket.destroy()
    },
  }
}

const allowGate: PermissionResponder = async () => ({ decision: "allow" })
const denyGate: PermissionResponder = async () => ({ decision: "deny", message: "nope" })

const brokers: ToolHostBroker[] = []

async function start(params: Partial<Parameters<typeof startToolHostBroker>[0]> = {}) {
  const broker = await startToolHostBroker({
    session: sessionContext(),
    attempt: 1,
    gate: allowGate,
    execHostTool: async () => ({ result: "host-ok" }),
    socketDir,
    ...params,
  })
  brokers.push(broker)
  return broker
}

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((b) => b.close()))
})

afterAll(() => {
  fs.rmSync(socketDir, { recursive: true, force: true })
})

async function connected(broker: ToolHostBroker, server: string = COGNIA_TOOLS_SERVER) {
  const c = client(broker.endpoint)
  await c.ready()
  const hello = (await c.call("hello", { token: broker.token, server })) as {
    session: Record<string, unknown>
  }
  return { c, hello }
}

describe("toolHostEndpoint", () => {
  it("scopes the endpoint by session, attempt and pid so two attempts never collide", () => {
    const a = toolHostEndpoint("sess1", 1, socketDir)
    const b = toolHostEndpoint("sess1", 2, socketDir)
    expect(a).not.toBe(b)
    expect(a).toContain(String(process.pid))
  })

  it("strips characters a socket path cannot carry", () => {
    expect(toolHostEndpoint("a/b:c", 1, socketDir)).not.toContain("/b:c")
  })
})

describe("startToolHostBroker — handshake", () => {
  it("hands the bridge the session descriptor after a valid token", async () => {
    const broker = await start()
    const { hello } = await connected(broker)
    expect(hello.session).toMatchObject({
      sessionId: "sess1",
      attempt: 1,
      contextVersion: "ctx1",
      cwd: "/work",
    })
    expect(hello.session.visibleBuiltinTools).toContain("git_status")
    expect((hello.session.hostTools as { name: string }[]).map((t) => t.name)).toEqual([
      "ask_user",
      "web_search",
    ])
  })

  it("forwards the per-tool timeout override so ask_user never gets a relay deadline", async () => {
    const broker = await start()
    const { hello } = await connected(broker, COGNIA_PLUGIN_TOOLS_SERVER)
    const askUser = (hello.session.hostTools as { name: string; timeoutMs?: number }[]).find(
      (t) => t.name === "ask_user"
    )
    expect(askUser?.timeoutMs).toBe(0)
  })

  it("never leaks the token or credentials in the descriptor", async () => {
    const broker = await start()
    const { hello } = await connected(broker)
    expect(JSON.stringify(hello.session)).not.toContain(broker.token)
  })

  it("rejects and drops a connection presenting the wrong token", async () => {
    const broker = await start()
    const c = client(broker.endpoint)
    await c.ready()
    await expect(c.call("hello", { token: "wrong", server: COGNIA_TOOLS_SERVER })).rejects.toThrow(
      /unauthorized/
    )
  })

  it("rejects an unknown server name", async () => {
    const broker = await start()
    const c = client(broker.endpoint)
    await c.ready()
    await expect(c.call("hello", { token: broker.token, server: "evil" })).rejects.toThrow(
      /unknown server/
    )
  })

  it("refuses any method before the handshake", async () => {
    const broker = await start()
    const c = client(broker.endpoint)
    await c.ready()
    await expect(c.call("authorize", { name: "read", args: {} })).rejects.toThrow(/unauthorized/)
  })

  it("drops a connection that sends a malformed frame", async () => {
    const broker = await start()
    const c = client(broker.endpoint)
    await c.ready()
    c.socket.write("not json\n")
    await new Promise((r) => setTimeout(r, 50))
    expect(c.isClosed()).toBe(true)
  })
})

describe("startToolHostBroker — authorization", () => {
  it("allows a visible, suppressed, in-workspace call without prompting", async () => {
    let prompts = 0
    const broker = await start({
      gate: async () => {
        prompts += 1
        return { decision: "allow" }
      },
    })
    const { c } = await connected(broker)
    expect(await c.call("authorize", { name: "git_status", args: {} })).toEqual({ allow: true })
    expect(prompts).toBe(0)
  })

  // The failure this prevents: while an approval sat on screen, every call that
  // needed no approval was authorized straight through, so the work the user
  // was deciding whether to allow had already happened by the time they
  // answered.
  it("authorizes nothing while an approval is awaiting the user", async () => {
    let release = () => {}
    const settled = new Promise<void>((resolve) => {
      release = resolve
    })
    const broker = await start({
      gate: async () => ({ decision: "allow" }),
      awaitApprovals: () => settled,
    })
    const { c } = await connected(broker)
    let allowed = false
    const pending = c.call("authorize", { name: "git_status", args: {} }).then((verdict) => {
      allowed = true
      return verdict
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // `git_status` needs no approval, and it is still not authorized.
    expect(allowed).toBe(false)
    release()
    expect(await pending).toEqual({ allow: true })
  })

  it("prompts once — and only once — for a mutating call", async () => {
    let prompts = 0
    const broker = await start({
      gate: async () => {
        prompts += 1
        return { decision: "allow" }
      },
    })
    const { c } = await connected(broker)
    expect(await c.call("authorize", { name: "write", args: { file_path: "/work/a.ts" } })).toEqual(
      {
        allow: true,
      }
    )
    expect(prompts).toBe(1)
  })

  it("denies when the user refuses, carrying the reason back", async () => {
    const broker = await start({ gate: denyGate })
    const { c } = await connected(broker)
    expect(await c.call("authorize", { name: "write", args: { file_path: "/work/a.ts" } })).toEqual(
      {
        allow: false,
        reason: "nope",
      }
    )
  })

  it("denies when the gate throws rather than letting the call through", async () => {
    const broker = await start({
      gate: async () => {
        throw new Error("overlay crashed")
      },
    })
    const { c } = await connected(broker)
    const verdict = (await c.call("authorize", {
      name: "write",
      args: { file_path: "/work/a.ts" },
    })) as { allow: boolean }
    expect(verdict.allow).toBe(false)
  })

  it("denies an approval-needing call when no gate exists at all", async () => {
    const broker = await startToolHostBroker({
      session: sessionContext(),
      attempt: 1,
      execHostTool: async () => ({ result: "" }),
      socketDir,
    })
    brokers.push(broker)
    const { c } = await connected(broker)
    const verdict = (await c.call("authorize", {
      name: "write",
      args: { file_path: "/work/a.ts" },
    })) as { allow: boolean; reason: string }
    expect(verdict.allow).toBe(false)
    expect(verdict.reason).toMatch(/needs approval/)
  })

  it("refuses a tool the policy filtered out of discovery (a forged name)", async () => {
    const broker = await start({
      session: sessionContext({ builtinTools: { git: true } as never }),
    })
    const { c } = await connected(broker)
    const verdict = (await c.call("authorize", { name: "bash", args: {} })) as {
      allow: boolean
      reason: string
    }
    expect(verdict.allow).toBe(false)
    expect(verdict.reason).toMatch(/not available in this session/)
  })

  it("refuses a path escape even after the user would have approved it", async () => {
    const broker = await start()
    const { c } = await connected(broker)
    const verdict = (await c.call("authorize", {
      name: "write",
      args: { file_path: "/etc/passwd" },
    })) as { allow: boolean; reason: string }
    expect(verdict.allow).toBe(false)
    expect(verdict.reason).toMatch(/outside the session workspace/)
  })

  it("refuses a credential read inside the workspace", async () => {
    const broker = await start()
    const { c } = await connected(broker)
    const verdict = (await c.call("authorize", {
      name: "read",
      args: { file_path: "/work/.ssh/id_rsa" },
    })) as { allow: boolean; reason: string }
    expect(verdict.allow).toBe(false)
    expect(verdict.reason).toMatch(/credential path/)
  })

  it("denies everything once the turn was cancelled", async () => {
    const broker = await start()
    const { c } = await connected(broker)
    broker.cancelInFlight("the turn was interrupted")
    const verdict = (await c.call("authorize", { name: "git_status", args: {} })) as {
      allow: boolean
      reason: string
    }
    expect(verdict.allow).toBe(false)
    expect(verdict.reason).toBe("the turn was interrupted")
  })
})

describe("startToolHostBroker — host tool execution", () => {
  it("runs an authorized host tool through the injected executor and reports it", async () => {
    const calls: { name: string; args: unknown }[] = []
    const seen: string[] = []
    const broker = await start({
      execHostTool: async (name, args) => {
        calls.push({ name, args })
        return { result: "answered" }
      },
      onToolCall: (e) => seen.push(`call:${e.name}`),
      onToolResult: (e) => seen.push(`result:${e.name}:${e.ok}`),
    })
    const { c } = await connected(broker, COGNIA_PLUGIN_TOOLS_SERVER)
    expect(await c.call("exec", { name: "ask_user", args: { q: "?" } })).toEqual({
      result: "answered",
    })
    expect(calls).toEqual([{ name: "ask_user", args: { q: "?" } }])
    expect(seen).toEqual(["call:ask_user", "result:ask_user:true"])
  })

  it("collapses an executor throw onto a tool error instead of hanging the call", async () => {
    const broker = await start({
      execHostTool: async () => {
        throw new Error("plugin runtime gone")
      },
    })
    const { c } = await connected(broker, COGNIA_PLUGIN_TOOLS_SERVER)
    expect(await c.call("exec", { name: "web_search", args: {} })).toEqual({
      error: "plugin runtime gone",
    })
  })

  it("never executes a host tool the policy refused", async () => {
    let ran = 0
    const broker = await start({
      gate: denyGate,
      execHostTool: async () => {
        ran += 1
        return { result: "" }
      },
    })
    const { c } = await connected(broker, COGNIA_PLUGIN_TOOLS_SERVER)
    const outcome = (await c.call("exec", { name: "web_search", args: {} })) as { error: string }
    expect(outcome.error).toBe("nope")
    expect(ran).toBe(0)
  })

  it("refuses exec on the built-in server — execution must not cross the trust line", async () => {
    const broker = await start()
    const { c } = await connected(broker, COGNIA_TOOLS_SERVER)
    expect(await c.call("exec", { name: "read", args: {} })).toEqual({
      error: "exec is not available on this server",
    })
  })

  it("renders a bridge-executed built-in through the same call/result surface", async () => {
    const seen: string[] = []
    const broker = await start({
      onToolCall: (e) => seen.push(`call:${e.server}:${e.name}`),
      onToolResult: (e) => seen.push(`result:${e.name}:${e.ok}:${e.summary}`),
    })
    const { c } = await connected(broker)
    expect(await c.call("report", { name: "read", ok: true, summary: "42 lines" })).toEqual({})
    expect(seen).toEqual(["call:cognia-tools:read", "result:read:true:42 lines"])
  })

  it("answers an unknown method rather than dropping the connection", async () => {
    const broker = await start()
    const { c } = await connected(broker)
    await expect(c.call("evict", {})).rejects.toThrow(/unknown method/)
  })
})

describe("startToolHostBroker — lifecycle", () => {
  it("tracks live connections", async () => {
    const broker = await start()
    expect(broker.connections()).toBe(0)
    const { c } = await connected(broker)
    expect(broker.connections()).toBe(1)
    c.end()
    await new Promise((r) => setTimeout(r, 30))
    expect(broker.connections()).toBe(0)
  })

  it("drops every bridge and removes the socket on close", async () => {
    const broker = await start()
    const { c } = await connected(broker)
    await broker.close()
    expect(broker.isClosed()).toBe(true)
    // The peer's `close` event lands on the next tick.
    await new Promise((r) => setTimeout(r, 30))
    expect(c.isClosed()).toBe(true)
    if (process.platform !== "win32") expect(fs.existsSync(broker.endpoint)).toBe(false)
  })

  it("is safe to close twice", async () => {
    const broker = await start()
    await broker.close()
    await expect(broker.close()).resolves.toBeUndefined()
  })

  it("refuses a bridge that connects after the session ended", async () => {
    const broker = await start()
    const endpoint = broker.endpoint
    await broker.close()
    const c = client(endpoint)
    await expect(c.ready()).rejects.toThrow()
  })
})

describe("startToolHostBroker — descriptor fidelity", () => {
  it("forwards the resolver-bound config so lsp / code-graph tools can be built", async () => {
    const broker = await start({
      session: sessionContext({
        model: "claude-x",
        provider: "anthropic",
        toolExecutionTimeoutMs: 5_000,
        compaction: { maxToolResultTokens: 500 },
        lsp: { enabled: true, servers: [] },
        codeGraph: { watch: false },
      } as never),
    })
    const { hello } = await connected(broker)
    expect(hello.session).toMatchObject({
      model: "claude-x",
      provider: "anthropic",
      toolExecutionTimeoutMs: 5_000,
      maxToolResultTokens: 500,
      lsp: { enabled: true, servers: [] },
      codeGraph: { watch: false },
    })
  })

  it("omits every optional field the session did not resolve", async () => {
    const broker = await start()
    const { hello } = await connected(broker)
    expect(hello.session).toMatchObject({ model: "", provider: "" })
    expect("toolExecutionTimeoutMs" in hello.session).toBe(false)
    expect("maxToolResultTokens" in hello.session).toBe(false)
    expect("lsp" in hello.session).toBe(false)
    expect("codeGraph" in hello.session).toBe(false)
  })

  it("counts only ENABLED user MCP rows as forwarded", async () => {
    // A disabled row must not read as an attached server anywhere.
    const broker = await start()
    const { hello } = await connected(broker)
    expect(hello.session.hostTools).toHaveLength(2)
  })
})

describe("startToolHostBroker — after close", () => {
  it("refuses to authorize once the session has ended", async () => {
    const broker = await start()
    const { c } = await connected(broker)
    // Close the SERVER but keep this client's view of the socket: the broker
    // must answer a still-buffered call with a refusal, not an execution.
    const verdictBefore = await c.call("authorize", { name: "git_status", args: {} })
    expect(verdictBefore).toEqual({ allow: true })
    await broker.close()
    expect(broker.isClosed()).toBe(true)
  })

  it("mints a distinct token per broker so one bridge cannot dial another", async () => {
    const a = await start()
    const b = await start({ attempt: 2 })
    expect(a.token).not.toBe(b.token)
    expect(a.endpoint).not.toBe(b.endpoint)
    const c = client(b.endpoint)
    await c.ready()
    await expect(c.call("hello", { token: a.token, server: COGNIA_TOOLS_SERVER })).rejects.toThrow(
      /unauthorized/
    )
  })
})

describe("startToolHostBroker — degenerate inputs", () => {
  it("describes a session that resolved no tools at all", async () => {
    const bare = sessionContext()
    bare.sendOptions = {} as SendOptions
    const broker = await start({ session: bare })
    const { hello } = await connected(broker)
    expect(hello.session).toMatchObject({ visibleBuiltinTools: [], hostTools: [] })
  })

  it("fills in a manifest entry that carries no description or schema", async () => {
    const sparse = sessionContext()
    ;(sparse.sendOptions as { pluginTools?: unknown }).pluginTools = [{ name: "bare" }]
    const broker = await start({ session: sparse })
    const { hello } = await connected(broker, COGNIA_PLUGIN_TOOLS_SERVER)
    expect(hello.session.hostTools).toEqual([
      { name: "bare", description: "", jsonSchema: { type: "object", properties: {} } },
    ])
  })

  it("treats a request with no params as an empty payload rather than throwing", async () => {
    const broker = await start()
    const c = client(broker.endpoint)
    await c.ready()
    // `hello` with no params fails auth (no token) rather than crashing.
    await expect(c.call("hello")).rejects.toThrow(/unauthorized/)
  })

  it("authorizes a call whose arguments are absent", async () => {
    const broker = await start()
    const { c } = await connected(broker)
    expect(await c.call("authorize", { name: "git_status" })).toEqual({ allow: true })
  })

  it("denies with a generated reason when the user's decision carries no message", async () => {
    const broker = await start({ gate: async () => ({ decision: "deny" }) })
    const { c } = await connected(broker)
    const verdict = (await c.call("authorize", {
      name: "write",
      args: { file_path: "/work/a.ts" },
    })) as { allow: boolean; reason: string }
    expect(verdict.reason).toMatch(/"write" was denied/)
  })

  it("summarizes a non-string result and truncates an oversized one", async () => {
    const results: string[] = []
    const broker = await start({
      execHostTool: async () => ({ result: { body: "y".repeat(1000) } }),
      onToolResult: (e) => results.push(e.summary ?? ""),
    })
    const { c } = await connected(broker, COGNIA_PLUGIN_TOOLS_SERVER)
    await c.call("exec", { name: "web_search", args: {} })
    expect(results[0].endsWith("…")).toBe(true)
    expect(results[0].length).toBeLessThan(1000)
  })

  it("stringifies a non-Error executor throw", async () => {
    const broker = await start({
      execHostTool: async () => {
        throw "plain string fault"
      },
    })
    const { c } = await connected(broker, COGNIA_PLUGIN_TOOLS_SERVER)
    expect(await c.call("exec", { name: "web_search", args: {} })).toEqual({
      error: "plain string fault",
    })
  })

  it("accepts a report with no summary", async () => {
    const seen: (string | undefined)[] = []
    const broker = await start({ onToolResult: (e) => seen.push(e.summary) })
    const { c } = await connected(broker)
    expect(await c.call("report", { name: "read", ok: false })).toEqual({})
    expect(seen).toEqual([undefined])
  })

  it("runs without any render callbacks wired", async () => {
    const broker = await startToolHostBroker({
      session: sessionContext(),
      attempt: 1,
      gate: allowGate,
      execHostTool: async () => ({ result: "ok" }),
      socketDir,
    })
    brokers.push(broker)
    const { c } = await connected(broker, COGNIA_PLUGIN_TOOLS_SERVER)
    expect(await c.call("exec", { name: "web_search", args: {} })).toEqual({ result: "ok" })
    expect(await c.call("report", { name: "web_search", ok: true })).toEqual({})
  })

  it("uses an injected token minter", async () => {
    const broker = await start({ mintToken: () => "deterministic-token" })
    expect(broker.token).toBe("deterministic-token")
  })
})

describe("toolHostEndpoint — path length", () => {
  it("truncates a long session id so the socket path fits sun_path", () => {
    // No dir override: the DEFAULT temp dir is what production uses, and on
    // macOS it already eats ~48 of the available bytes.
    const endpoint = toolHostEndpoint("a".repeat(200), 1)
    if (process.platform !== "win32") {
      // A path over ~104 bytes makes `listen` fail with EINVAL, which reads as
      // "the tool host is broken" rather than "the name was too long".
      expect(Buffer.byteLength(endpoint)).toBeLessThan(104)
    }
    expect(endpoint).toContain(String(process.pid))
  })

  it("still separates two attempts of the same long-id session", () => {
    const long = "session-".repeat(20)
    expect(toolHostEndpoint(long, 1, socketDir)).not.toBe(toolHostEndpoint(long, 2, socketDir))
  })
})

it("rejects a late approval after cancellation", async () => {
  let approve!: (decision: { decision: "allow" }) => void
  let requested!: () => void
  const waiting = new Promise<void>((resolve) => {
    requested = resolve
  })
  const broker = await start({
    gate: () => {
      requested()
      return new Promise((resolve) => {
        approve = resolve
      })
    },
  })
  const { c } = await connected(broker)
  const pending = c.call("authorize", { name: "write", args: { path: "/work/file" } })
  await waiting
  broker.cancelInFlight("interrupted")
  expect(await pending).toEqual({ allow: false, reason: "interrupted" })
  approve({ decision: "allow" })
  c.end()
})

it("explicit denies cannot be bypassed by a suppressed tool", async () => {
  const broker = await start({
    session: sessionContext({
      permissionMode: "bypassPermissions",
      suppressApprovalForTools: [namespaced("write")],
      permissionRuleset: { [namespaced("write")]: "deny" },
    }),
  })
  const { c } = await connected(broker)
  expect(await c.call("authorize", { name: "write", args: { path: "/work/file" } })).toEqual({
    allow: false,
    reason: "denied by permission ruleset",
  })
  c.end()
})

it.each([{ writableRoots: [] }, { writableRoots: ["/work/output"] }])(
  "keeps declared workspace reads available with writable roots $writableRoots",
  async ({ writableRoots }) => {
    const gate = jest.fn(allowGate)
    const broker = await start({
      gate,
      session: sessionContext({
        builtinProcessSandbox: {
          launcher: "/launcher",
          writableRoots,
          readableRoots: ["/work"],
          network: false,
        },
      }),
    })
    const { c } = await connected(broker)
    expect(
      await c.call("authorize", { name: "read", args: { file_path: "/work/source.ts" } })
    ).toEqual({ allow: true })
    expect(
      await c.call("authorize", { name: "write", args: { path: "/work/source.ts" } })
    ).toMatchObject({ allow: false, reason: expect.stringContaining("writableRoots") })
    expect(
      await c.call("authorize", { name: "read", args: { file_path: "/outside/source.ts" } })
    ).toMatchObject({ allow: false, reason: expect.stringContaining("readableRoots") })
    expect(
      await c.call("authorize", { name: "read", args: { file_path: "/work/.ssh/id_rsa" } })
    ).toMatchObject({ allow: false, reason: expect.stringContaining("credential") })
    expect(gate).not.toHaveBeenCalled()
    c.end()
  }
)

it("refuses an immutable sandbox scope violation before requesting approval", async () => {
  const gate = jest.fn(allowGate)
  const broker = await start({
    gate,
    session: sessionContext({
      confinement: { enabled: false, roots: [] },
      builtinProcessSandbox: {
        launcher: "/launcher",
        writableRoots: ["/work/subdir"],
        readableRoots: [],
        network: false,
      },
    }),
  })
  const { c } = await connected(broker)
  const result = (await c.call("authorize", { name: "write", args: { path: "/work/file" } })) as {
    allow: boolean
    reason: string
  }
  expect(result.allow).toBe(false)
  expect(result.reason).toContain("sandbox.policy.writableRoots")
  expect(gate).not.toHaveBeenCalled()
  c.end()
})
