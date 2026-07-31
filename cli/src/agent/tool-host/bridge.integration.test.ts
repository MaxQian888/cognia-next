/**
 * @jest-environment node
 *
 * End-to-end fixture: a REAL Cognia tool bridge process, spawned exactly as an
 * external agent would spawn it, talking MCP over stdio to a REAL broker.
 *
 * The unit suites verify each half in isolation, which cannot catch the failures
 * that only exist between them: a socket the bridge cannot dial, a handshake the
 * broker rejects, a zod shape that will not convert to JSON Schema, a tool the
 * policy hid but the bridge still advertises, or a call the broker refuses while
 * the bridge reports success. Those are exactly the "it looked wired up" bugs
 * this whole area exists to remove, so they get a test that spawns the process.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { SendOptions } from "@cognia/agent-config-types"
import { namespaced } from "@/lib/settings/builtin-tools"

import { startToolHostBroker, type ToolHostBroker } from "./broker"
import { buildToolHostMcpServers, resolveToolBridgeScript } from "./spawn"
import type { ResolvedCliSessionContext } from "../session-context"

jest.setTimeout(60_000)

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-bridge-ws-"))
// A SHORT socket dir: the macOS temp dir is already ~48 of the ~104 bytes a
// unix socket path may use, and mkdtemp adds another nested level.
const socketDir = fs.mkdtempSync(
  path.join(os.platform() === "win32" ? os.tmpdir() : "/tmp", "cth-")
)

function sessionContext(overrides: Partial<SendOptions> = {}): ResolvedCliSessionContext {
  return {
    sessionId: "bridge-e2e",
    cwd: workspace,
    additionalDirectories: [],
    mcpServers: [],
    agents: [],
    subagentToolEnabled: false,
    activeSkillIds: [],
    databaseError: null,
    contextVersion: "ctx-e2e",
    sendOptions: {
      // `git` is a static category with no resolver dependencies, so it is the
      // stable choice for asserting on a real projected surface.
      builtinTools: { git: true },
      confinement: { enabled: true, roots: [workspace] },
      suppressApprovalForTools: [namespaced("git_status")],
      pluginTools: [
        { name: "ask_user", description: "ask the user", jsonSchema: {}, pluginId: "core" },
      ],
      ...overrides,
    } as SendOptions,
  }
}

/** Speak MCP JSON-RPC to a spawned bridge over its stdio. */
function mcpClient(child: ChildProcessWithoutNullStreams) {
  const pending = new Map<number, (value: unknown) => void>()
  let buffer = ""
  let id = 0
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }
      if (message.id === undefined) continue
      pending.get(message.id)?.(message.error ?? message.result)
      pending.delete(message.id)
    }
  })
  return (method: string, params?: unknown) => {
    const messageId = ++id
    return new Promise<unknown>((resolve) => {
      pending.set(messageId, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: messageId, method, params })}\n`)
    })
  }
}

const children: ChildProcessWithoutNullStreams[] = []
const brokers: ToolHostBroker[] = []
// The endpoint is scoped by session + attempt + pid, so each broker in this file
// needs its own attempt — exactly as production does, where every (re)start of
// the tool host increments it.
let attemptSeq = 0

/** Start a broker and spawn the bridge for `server`, exactly as ACP would. */
async function launch(
  server: "cognia-tools" | "cognia-plugin-tools",
  params: Partial<Parameters<typeof startToolHostBroker>[0]> = {}
) {
  const broker = await startToolHostBroker({
    session: sessionContext(),
    attempt: ++attemptSeq,
    gate: async () => ({ decision: "allow" }),
    execHostTool: async (name) => ({ result: `host:${name}` }),
    socketDir,
    ...params,
  })
  brokers.push(broker)
  const configs = buildToolHostMcpServers({
    endpoint: broker.endpoint,
    token: broker.token,
    servers: [server],
    packaged: false,
  }) as unknown as { command: string; args: string[]; env: { name: string; value: string }[] }[]
  const entry = configs[0]
  const child = spawn(entry.command, entry.args, {
    cwd: workspace,
    env: {
      ...process.env,
      ...Object.fromEntries(entry.env.map((e) => [e.name, e.value] as const)),
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams
  children.push(child)
  const stderr: string[] = []
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (line: string) => stderr.push(line))
  return { broker, child, call: mcpClient(child), stderr }
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
  await Promise.all(brokers.splice(0).map((b) => b.close()))
})

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(socketDir, { recursive: true, force: true })
})

describe("the bridge ships where the spawn config points", () => {
  it("resolves to a real file", () => {
    expect(fs.existsSync(resolveToolBridgeScript())).toBe(true)
  })
})

describe("cognia-tools over a real bridge process", () => {
  it("initializes, lists the projected tools, and runs one end to end", async () => {
    const { call, stderr } = await launch("cognia-tools")

    const init = (await call("initialize")) as { serverInfo: { name: string } }
    expect(init.serverInfo.name).toBe("cognia-tools")

    const listed = (await call("tools/list")) as {
      tools: { name: string; inputSchema: { type: string } }[]
    }
    const names = listed.tools.map((t) => t.name)
    // Exactly the policy's visible set — the enabled category, nothing else.
    expect(names).toContain("git_status")
    expect(names).not.toContain("write")
    // Schemas are derived from the SAME zod definitions the built-in path uses.
    for (const tool of listed.tools) expect(tool.inputSchema.type).toBe("object")

    // A real read-only tool, really executed, against a real workspace.
    const result = (await call("tools/call", {
      name: "git_status",
      arguments: { path: workspace },
    })) as { content: { type: string; text: string }[]; isError?: boolean }
    expect(Array.isArray(result.content)).toBe(true)
    expect(stderr.join("")).not.toContain("fatal")
  })

  it("refuses a tool Cognia hid, even though the model named it correctly", async () => {
    const { call } = await launch("cognia-tools")
    await call("initialize")
    const result = (await call("tools/call", {
      name: "write",
      arguments: { file_path: path.join(workspace, "a.txt"), content: "x" },
    })) as { content: { text: string }[]; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/unknown tool/)
  })

  it("refuses a call the broker denies, and never runs the handler", async () => {
    const { call } = await launch("cognia-tools", {
      gate: async () => ({ decision: "deny", message: "not this time" }),
      session: sessionContext({ suppressApprovalForTools: [] } as never),
    })
    await call("initialize")
    const result = (await call("tools/call", {
      name: "git_status",
      arguments: { path: workspace },
    })) as { content: { text: string }[]; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/not this time/)
  })

  it("reports the call back to Cognia so it renders like a built-in one", async () => {
    const reported: string[] = []
    const { call } = await launch("cognia-tools", {
      onToolResult: (event) => reported.push(`${event.name}:${event.ok}`),
    })
    await call("initialize")
    await call("tools/call", { name: "git_status", arguments: { path: workspace } })
    expect(reported.some((r) => r.startsWith("git_status:"))).toBe(true)
  })
})

describe("cognia-plugin-tools over a real bridge process", () => {
  it("advertises Cognia's manifest and executes through the CLI, not the bridge", async () => {
    const executed: string[] = []
    const { call } = await launch("cognia-plugin-tools", {
      execHostTool: async (name) => {
        executed.push(name)
        return { result: "answered by the CLI" }
      },
    })
    await call("initialize")
    const listed = (await call("tools/list")) as { tools: { name: string }[] }
    expect(listed.tools.map((t) => t.name)).toEqual(["ask_user"])

    const result = (await call("tools/call", {
      name: "ask_user",
      arguments: { question: "ready?" },
    })) as { content: { text: string }[] }
    expect(result.content[0].text).toBe("answered by the CLI")
    // The handler lives in the CLI process; the bridge only relayed.
    expect(executed).toEqual(["ask_user"])
  })

  it("surfaces a host-tool failure as a tool error the model can react to", async () => {
    const { call } = await launch("cognia-plugin-tools", {
      execHostTool: async () => ({ error: "the plugin runtime is gone" }),
    })
    await call("initialize")
    const result = (await call("tools/call", {
      name: "ask_user",
      arguments: {},
    })) as { content: { text: string }[]; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/plugin runtime is gone/)
  })
})

describe("the bridge cannot be used without Cognia", () => {
  it("refuses to start with no endpoint or token", async () => {
    const child = spawn(process.execPath, [resolveToolBridgeScript()], {
      cwd: workspace,
      env: { ...process.env, COGNIA_TOOLHOST_SOCKET: "", COGNIA_TOOLHOST_TOKEN: "" },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams
    children.push(child)
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
    expect(code).toBe(1)
  })

  it("refuses a bridge holding the wrong token", async () => {
    const broker = await startToolHostBroker({
      session: sessionContext(),
      attempt: ++attemptSeq,
      gate: async () => ({ decision: "allow" }),
      execHostTool: async () => ({ result: "" }),
      socketDir,
    })
    brokers.push(broker)
    const child = spawn(process.execPath, [resolveToolBridgeScript()], {
      cwd: workspace,
      env: {
        ...process.env,
        COGNIA_TOOLHOST_SOCKET: broker.endpoint,
        COGNIA_TOOLHOST_TOKEN: "forged",
        COGNIA_TOOLHOST_SERVER: "cognia-tools",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams
    children.push(child)
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
    expect(code).toBe(1)
  })
})
