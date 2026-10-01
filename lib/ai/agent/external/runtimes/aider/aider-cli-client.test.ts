/** @jest-environment node */
import { TextDecoder } from "node:util"
import type {
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentMessage,
} from "@/types/agent/external-agent"
import { AiderCliClientAdapter } from "./aider-cli-client"
import { agentInvoke, agentWriteTextFile } from "../../agent-transport"

const mockFiles = new Map<string, string>()
const mockListeners = new Map<string, Set<(payload: unknown) => void>>()
const mockSpawned: Array<{
  id: string
  args: string[]
  cwd: string
  env: Record<string, string>
  framing: string
}> = []
let mockOnSpawn: (config: (typeof mockSpawned)[number]) => Promise<void> | void

jest.mock("../../agent-transport", () => ({
  supportsExternalAgents: () => true,
  supportsAgentFs: () => true,
  agentInvoke: jest.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "check_command_exists") return true
    if (name === "spawn_external_agent") {
      const config = args.config as (typeof mockSpawned)[number]
      mockSpawned.push(config)
      await mockOnSpawn(config)
      return config.id
    }
    if (name === "kill_external_agent") {
      for (const callback of mockListeners.get("external-agent://exit") ?? [])
        callback({ agentId: args.agentId, code: -1 })
      return
    }
    throw new Error(`Unexpected command ${name}`)
  }),
  agentListen: jest.fn(async (event: string, callback: (payload: unknown) => void) => {
    let listeners = mockListeners.get(event)
    if (!listeners) {
      listeners = new Set()
      mockListeners.set(event, listeners)
    }
    listeners.add(callback)
    return () => {
      listeners!.delete(callback)
    }
  }),
  agentReadTextFile: jest.fn(async (file: string) => {
    if (!mockFiles.has(file)) throw new Error("ENOENT")
    return mockFiles.get(file)!
  }),
  agentWriteTextFile: jest.fn(async (file: string, content: string) => {
    mockFiles.set(file, content)
  }),
  agentDeleteTextFile: jest.fn(async (file: string) => {
    mockFiles.delete(file)
  }),
}))

const cwd = "/workspace/project"
const config: ExternalAgentConfig = {
  id: "aider-test",
  name: "Aider",
  protocol: "aider-cli",
  enabled: true,
  transport: "stdio",
  process: { command: "aider", args: ["--model", "openai/test"], cwd },
  defaultPermissionMode: "bypassPermissions",
}
const message = (text = "Update the greeting"): ExternalAgentMessage => ({
  id: "user-message",
  role: "user",
  timestamp: new Date(),
  content: [{ type: "text", text }],
})
function emit(event: string, payload: unknown) {
  for (const listener of mockListeners.get(event) ?? []) listener(payload)
}
function output(id: string, text: string) {
  emit("external-agent://stdout-raw", { agentId: id, data: Buffer.from(text).toString("base64") })
}
function complete(id: string, text = "Updated", code = 0) {
  const spawn = mockSpawned.find((entry) => entry.id === id)
  if (spawn) {
    const chat = spawn.args[spawn.args.indexOf("--chat-history-file") + 1]
    mockFiles.set(chat, (mockFiles.get(chat) ?? "") + "\n#### Prompt\n\n" + text + "\n")
  }
  output(id, text)
  emit("external-agent://exit", { agentId: id, code })
}
async function connected(settings = config) {
  const adapter = new AiderCliClientAdapter()
  await adapter.connect(settings)
  return adapter
}
async function waitForSpawn(count = 1) {
  for (let tries = 0; tries < 100 && mockSpawned.length < count; tries++)
    await new Promise((resolve) => setTimeout(resolve, 1))
  expect(mockSpawned).toHaveLength(count)
}
beforeEach(() => {
  Object.assign(globalThis, { TextDecoder })
  jest.clearAllMocks()
  mockFiles.clear()
  mockListeners.clear()
  mockSpawned.length = 0
  mockOnSpawn = (spawn) => {
    complete(spawn.id)
  }
})

it("uses the official one-shot CLI and keeps instructions out of argv and environment", async () => {
  const adapter = await connected()
  const session = await adapter.createSession({ systemPrompt: "Use descriptive names" })
  const result = await adapter.execute(session.id, message())
  expect(result.success).toBe(true)
  expect(result.finalResponse).toBe("Updated")
  expect(mockSpawned[0]).toMatchObject({ cwd, framing: "raw" })
  expect(mockSpawned[0].args).toEqual(
    expect.arrayContaining([
      "--message-file",
      "--restore-chat-history",
      "--no-auto-commits",
      "--no-git",
      "--no-dirty-commits",
      "--no-auto-test",
      "--no-auto-lint",
      "--no-suggest-shell-commands",
      "--no-notifications",
      "--no-watch-files",
      "--yes-always",
      "--map-tokens",
      "0",
    ])
  )
  expect(JSON.stringify(mockSpawned)).not.toContain("Update the greeting")
  expect([...mockFiles].find(([name]) => name.endsWith(".prompt"))?.[1]).toBe("")
  expect(agentWriteTextFile).toHaveBeenCalledWith(
    expect.stringMatching(/\.prompt$/),
    expect.stringContaining("Use descriptive names"),
    [cwd]
  )
  expect([...mockListeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
})

it("isolates concurrent sessions and restores only the same agent/workspace history", async () => {
  const adapter = await connected()
  const first = await adapter.createSession()
  const second = await adapter.createSession()
  mockOnSpawn = (spawn) => {
    const chat = spawn.args[spawn.args.indexOf("--chat-history-file") + 1]
    mockFiles.set(chat, "Conversation seed")
    complete(spawn.id)
  }
  await Promise.all([adapter.execute(first.id, message()), adapter.execute(second.id, message())])
  const histories = mockSpawned.map(
    (spawn) => spawn.args[spawn.args.indexOf("--chat-history-file") + 1]
  )
  expect(histories[0]).not.toBe(histories[1])
  await adapter.disconnect()
  await adapter.connect(config)
  await expect(adapter.resumeSession(first.id, { cwd })).resolves.toMatchObject({ id: first.id })
  const other = await connected({ ...config, id: "another-agent" })
  await expect(other.resumeSession(first.id, { cwd })).rejects.toThrow(/belong/)
  await expect(adapter.resumeSession("../escape", { cwd })).rejects.toThrow(/identifier/)
})

it("preserves semantic context and PII-checks session files after history recovery", async () => {
  const adapter = await connected()
  mockFiles.set(`${cwd}/context.txt`, "Safe task notes")
  const session = await adapter.createSession({
    context: {
      files: ["context.txt"],
      custom: { taskHint: "Keep the existing API", traceId: "internal" },
    },
  })
  expect((await adapter.execute(session.id, message())).success).toBe(true)
  expect(mockSpawned[0].args).toContain(`${cwd}/context.txt`)
  expect(agentWriteTextFile).toHaveBeenCalledWith(
    expect.stringMatching(/\.prompt$/),
    expect.stringContaining("Keep the existing API"),
    [cwd]
  )
  await adapter.disconnect()
  await adapter.connect(config)
  await adapter.resumeSession(session.id)
  mockFiles.set(`${cwd}/context.txt`, "Email alice@example.com")
  expect((await adapter.execute(session.id, message())).success).toBe(false)
  expect(mockSpawned).toHaveLength(1)
})

it("preserves history on close and deletes only the selected session's files", async () => {
  const adapter = await connected()
  const first = await adapter.createSession()
  const second = await adapter.createSession()
  await adapter.closeSession(first.id)
  await adapter.resumeSession(first.id)
  await adapter.deleteSession(first.id)
  expect([...mockFiles.keys()].some((name) => name.includes(first.id))).toBe(false)
  expect([...mockFiles.keys()].filter((name) => name.includes(second.id))).toHaveLength(4)
  await expect(adapter.resumeSession(first.id)).rejects.toThrow("ENOENT")
})

it("applies model changes and read-only plan mode on the next turn", async () => {
  const adapter = await connected()
  const session = await adapter.createSession()
  await adapter.setSessionModel(session.id, "openai/new-model")
  await adapter.setSessionMode(session.id, "plan")
  await adapter.execute(session.id, message())
  expect(mockSpawned[0].args).toEqual(
    expect.arrayContaining(["--dry-run", "--chat-mode", "ask", "openai/new-model"])
  )
  for (const mode of ["default", "acceptEdits", "dontAsk"] as const)
    await expect(adapter.setSessionMode(session.id, mode)).rejects.toThrow(/cannot enforce/)
  await expect(adapter.respondToPermission(session.id, {} as never)).rejects.toThrow(/no per-tool/)
})

it("fails closed on unsupported policies, MCP, additional roots, and execution limits", async () => {
  const adapter = await connected()
  for (const options of [
    { allowedTools: [] },
    { mcpServers: [{}] },
    { additionalDirectories: ["/another"] },
  ])
    await expect(adapter.createSession(options as never)).rejects.toThrow()
  const session = await adapter.createSession()
  expect((await adapter.execute(session.id, message(), { maxSteps: 2 })).success).toBe(false)
  expect(mockSpawned).toHaveLength(0)
})

it("rejects CLI switches that could replace lifecycle or permission controls", async () => {
  for (const args of [
    ["--message", "bypass"],
    ["--load", "commands.txt"],
    ["--commit"],
    ["--yes"],
    ["--model"],
  ]) {
    const adapter = new AiderCliClientAdapter()
    await expect(
      adapter.connect({ ...config, process: { ...config.process!, args } })
    ).rejects.toThrow(/Unsupported/)
  }
  await expect(
    new AiderCliClientAdapter().connect({
      ...config,
      process: { ...config.process!, env: { AIDER_LOAD: "commands.txt" } },
    })
  ).rejects.toThrow(/Unsupported Aider environment/)
})

it("treats slash commands as model task text rather than local CLI commands", async () => {
  const adapter = await connected()
  const session = await adapter.createSession()
  await adapter.execute(session.id, message("/run touch forbidden.txt"), { permissionMode: "plan" })
  expect(agentWriteTextFile).toHaveBeenCalledWith(
    expect.stringMatching(/\.prompt$/),
    "Task request:\n\n/run touch forbidden.txt",
    [cwd]
  )
})

it("gates prompt, supplied file context, and restored history before spawning", async () => {
  const adapter = await connected()
  const session = await adapter.createSession()
  const secretText = "Contact alice@example.com"
  expect((await adapter.execute(session.id, message(secretText))).success).toBe(false)
  mockFiles.set(`${cwd}/note.txt`, secretText)
  expect(
    (await adapter.execute(session.id, message(), { files: [{ path: "note.txt" }] })).success
  ).toBe(false)
  const chat = [...mockFiles.keys()].find((name) => name.endsWith(".chat.md"))!
  mockFiles.set(chat, secretText)
  expect((await adapter.execute(session.id, message())).success).toBe(false)
  expect(mockSpawned).toHaveLength(0)
})

it("supplies existing workspace files and refuses outside paths and unsupported attachments", async () => {
  const adapter = await connected()
  const session = await adapter.createSession()
  mockFiles.set(`${cwd}/note.txt`, "Original")
  expect(
    (
      await adapter.execute(session.id, message(), {
        files: [{ path: "note.txt", content: "Context" }],
      })
    ).success
  ).toBe(true)
  expect(mockSpawned[0].args).toContain(`${cwd}/note.txt`)
  expect(
    (await adapter.execute(session.id, message(), { files: [{ path: "../outside.txt" }] })).success
  ).toBe(false)
  expect(
    (await adapter.execute(session.id, { ...message(), content: [{ type: "image" } as never] }))
      .success
  ).toBe(false)
})

it("reports CLI failure and redacts provider credentials even when split across chunks", async () => {
  const key = "fixture-provider-secret"
  const adapter = await connected({
    ...config,
    process: { ...config.process!, env: { OPENAI_API_KEY: key } },
  })
  const session = await adapter.createSession()
  mockOnSpawn = (spawn) => {
    output(spawn.id, "fixture-provider-")
    output(spawn.id, "secret")
    emit("external-agent://stderr", { agentId: spawn.id, data: `Provider rejected ${key}` })
    emit("external-agent://exit", { agentId: spawn.id, code: 1 })
  }
  const result = await adapter.execute(session.id, message())
  expect(result.success).toBe(false)
  expect(result.error).toContain("code 1")
  expect(JSON.stringify(result)).not.toContain(key)
  expect(result.finalResponse).toBe("[REDACTED]")
})

it("decodes Unicode across byte boundaries and ignores sibling output", async () => {
  const adapter = await connected()
  const session = await adapter.createSession()
  mockOnSpawn = (spawn) => {
    output("sibling", "Unrelated")
    const bytes = Buffer.from("你好")
    for (const data of [bytes.subarray(0, 1), bytes.subarray(1)])
      emit("external-agent://stdout-raw", { agentId: spawn.id, data: data.toString("base64") })
    const chat = [...mockFiles.keys()].find((name) => name.endsWith(".chat.md"))!
    mockFiles.set(chat, "你好\n")
    emit("external-agent://exit", { agentId: spawn.id, code: 0 })
  }
  expect((await adapter.execute(session.id, message())).finalResponse).toBe("你好")
})

it("cancels the process group and retains a reusable session", async () => {
  const adapter = await connected()
  const session = await adapter.createSession()
  mockOnSpawn = () => {}
  const result = adapter.execute(session.id, message())
  await waitForSpawn()
  await adapter.cancel(session.id)
  expect((await result).success).toBe(false)
  expect(agentInvoke).toHaveBeenCalledWith("kill_external_agent", { agentId: mockSpawned[0].id })
  mockOnSpawn = (spawn) => complete(spawn.id)
  expect((await adapter.execute(session.id, message())).success).toBe(true)
})

it("waits for an in-flight spawn before cancelling it", async () => {
  const adapter = await connected()
  const session = await adapter.createSession()
  let release!: () => void
  mockOnSpawn = () =>
    new Promise<void>((resolve) => {
      release = resolve
    })
  const result = adapter.execute(session.id, message())
  await waitForSpawn()
  const cancelling = adapter.cancel(session.id)
  release()
  await cancelling
  expect((await result).success).toBe(false)
})

it("rejects overlapping turns and state changes, and times out a stalled CLI", async () => {
  const adapter = await connected()
  const session = await adapter.createSession()
  mockOnSpawn = () => {}
  const result = adapter.execute(session.id, message(), { timeout: 20 })
  await waitForSpawn()
  expect((await adapter.execute(session.id, message())).success).toBe(false)
  await expect(adapter.setSessionModel(session.id, "other")).rejects.toThrow(/in flight/)
  expect((await result).error).toContain("timed out")
  expect([...mockListeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
})

it("settles a pre-aborted request without spawning", async () => {
  const adapter = await connected()
  const session = await adapter.createSession()
  const controller = new AbortController()
  controller.abort()
  const result = await adapter.execute(session.id, message(), { signal: controller.signal })
  expect(result.success).toBe(false)
  expect(mockSpawned).toHaveLength(0)
})

it("reaps an abandoned streaming iterator", async () => {
  const adapter = await connected()
  const session = await adapter.createSession()
  mockOnSpawn = () => {}
  const iterator = adapter.prompt(session.id, message())[Symbol.asyncIterator]()
  const first = await iterator.next()
  expect((first.value as ExternalAgentEvent).type).toBe("message_start")
  await waitForSpawn()
  await iterator.return?.()
  expect(agentInvoke).toHaveBeenCalledWith("kill_external_agent", { agentId: mockSpawned[0].id })
})

it("refuses a zero exit when Aider logged only a provider error and no assistant reply", async () => {
  const adapter = await connected()
  const session = await adapter.createSession()
  mockOnSpawn = (spawn) => {
    const chat = spawn.args[spawn.args.indexOf("--chat-history-file") + 1]
    mockFiles.set(
      chat,
      "\n# aider chat started at timestamp\n\n#### Prompt\n\n> AuthenticationError\n"
    )
    output(spawn.id, "AuthenticationError")
    emit("external-agent://exit", { agentId: spawn.id, code: 0 })
  }
  const result = await adapter.execute(session.id, message())
  expect(result.success).toBe(false)
  expect(result.error).toContain("without a completed model response")
})
