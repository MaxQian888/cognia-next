/** @jest-environment node */
import { TextDecoder } from "node:util"
import type {
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentMessage,
} from "@cognia/agent-contracts/external-agent"
import type { AgentFileHost, AgentProcessHost } from "@cognia/agent-contracts/host"
import { AiderCliClientAdapter, type AiderCliClientDeps } from "./cli-client"
import { AIDER_CLI_EXECUTION_SEMANTICS } from "./manifest"

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

function subscribe(event: string) {
  return async (callback: (payload: { processId: string } & Record<string, unknown>) => void) => {
    let listeners = mockListeners.get(event)
    if (!listeners) {
      listeners = new Set()
      mockListeners.set(event, listeners)
    }
    // Fixtures emit the plane's `{ agentId }` payloads; the port speaks `processId`.
    const listener = (payload: unknown) => {
      const { agentId, ...rest } = payload as { agentId: string } & Record<string, unknown>
      callback({ processId: agentId, ...rest })
    }
    listeners.add(listener)
    return () => {
      listeners!.delete(listener)
    }
  }
}

const processHost = {
  available: true,
  commandExists: jest.fn(async () => true),
  spawn: jest.fn(async (spec: (typeof mockSpawned)[number]) => {
    mockSpawned.push(spec)
    await mockOnSpawn(spec)
    return spec.id
  }),
  send: jest.fn(async () => {
    throw new Error("Aider never writes to stdin")
  }),
  kill: jest.fn(async (processId: string) => {
    for (const callback of mockListeners.get("external-agent://exit") ?? [])
      callback({ agentId: processId, code: -1 })
  }),
  onStdoutLine: jest.fn(subscribe("external-agent://stdout")),
  onStdoutRaw: jest.fn(subscribe("external-agent://stdout-raw")),
  onStderr: jest.fn(subscribe("external-agent://stderr")),
  onExit: jest.fn(subscribe("external-agent://exit")),
} as unknown as jest.Mocked<AgentProcessHost>

const fileHost = {
  available: true,
  isWithinRoot: (path: string, root: string) => path === root || path.startsWith(`${root}/`),
  readText: jest.fn(async (file: string) => {
    if (!mockFiles.has(file)) throw new Error("ENOENT")
    return mockFiles.get(file)!
  }),
  writeText: jest.fn(async (file: string, content: string) => {
    mockFiles.set(file, content)
  }),
  delete: jest.fn(async (file: string) => {
    mockFiles.delete(file)
  }),
  readBinary: jest.fn(async (file: string) => {
    if (!mockFiles.has(file)) throw new Error("ENOENT")
    return mockFiles.get(file)!
  }),
  writeBinary: jest.fn(async (file: string, content: string) => {
    mockFiles.set(file, content)
  }),
  listFiles: jest.fn(async (dir: string) =>
    [...mockFiles.keys()].filter(
      (file) => file.startsWith(`${dir}/`) && !file.slice(dir.length + 1).includes("/")
    )
  ),
} as unknown as jest.Mocked<AgentFileHost & Record<string, jest.Mock>>

/** Stands in for the host's PII gate: refuses anything naming an e-mail address. */
const outboundGate = (payload: unknown) => !/[\w.]+@example\.com/.test(JSON.stringify(payload))

const deps: AiderCliClientDeps = {
  processHost,
  fileHost,
  outboundGate,
  redactDiagnostic: (text) => text.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED]"),
}

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
  const adapter = new AiderCliClientAdapter(deps)
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
  expect(fileHost.writeText).toHaveBeenCalledWith(
    expect.stringMatching(/\.prompt$/),
    expect.stringContaining("Use descriptive names"),
    [cwd]
  )
  expect([...mockListeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
})

it("discovers persisted sessions after restart without crossing agent identity", async () => {
  const adapter = await connected()
  const session = await adapter.createSession()
  await adapter.closeSession(session.id)
  await adapter.disconnect()
  const fresh = await connected()
  expect(await fresh.listSessions()).toEqual([
    expect.objectContaining({ sessionId: session.id, cwd }),
  ])
  const other = await connected({ ...config, id: "different" })
  expect(await other.listSessions()).toEqual([])
})

it.each([false, true])(
  "applies new resume instructions, model and permissions with cold=%s",
  async (cold) => {
    const adapter = await connected()
    const session = await adapter.createSession({ systemPrompt: "Old instruction" })
    if (cold) {
      await adapter.disconnect()
      await adapter.connect(config)
    }
    await adapter.resumeSession(session.id, {
      systemPrompt: "New instruction",
      permissionMode: "plan",
      metadata: { selectedModel: "new-model" },
    })
    await adapter.execute(session.id, message())
    expect(mockSpawned[0].args).toEqual(
      expect.arrayContaining(["--model", "new-model", "--chat-mode", "ask"])
    )
    const prompts = jest
      .mocked(fileHost.writeText)
      .mock.calls.filter(([file, content]) => file.endsWith(".prompt") && content)
    expect(prompts.at(-1)?.[1]).toContain("New instruction")
    expect(prompts.at(-1)?.[1]).not.toContain("Old instruction")
  }
)

it("rejects unsafe resume instructions without replacing the persisted preamble", async () => {
  const adapter = await connected()
  const session = await adapter.createSession({ systemPrompt: "Original instruction" })
  await expect(
    adapter.resumeSession(session.id, { systemPrompt: "Contact alice@example.com" })
  ).rejects.toThrow(/PII/)
  await adapter.execute(session.id, message())
  const prompts = jest
    .mocked(fileHost.writeText)
    .mock.calls.filter(([file, content]) => file.endsWith(".prompt") && content)
  expect(prompts.at(-1)?.[1]).toContain("Original instruction")
})

it("reads workspace images as binary and leaves user files in place", async () => {
  const adapter = await connected()
  const session = await adapter.createSession()
  mockFiles.set(`${cwd}/photo.png`, "iVBORw0KGgo=")
  const result = await adapter.execute(session.id, message(), { files: [{ path: "photo.png" }] })
  expect(result.success).toBe(true)
  expect(fileHost.readBinary).toHaveBeenCalledWith(`${cwd}/photo.png`, [cwd])
  expect(mockSpawned[0].args).toContain(`${cwd}/photo.png`)
  expect(mockFiles.has(`${cwd}/photo.png`)).toBe(true)
})

it.each([0, 1])("materializes an inline image and removes it after CLI exit %s", async (code) => {
  const adapter = await connected()
  const session = await adapter.createSession()
  let imagePath = ""
  mockOnSpawn = (spawn) => {
    imagePath = spawn.args.find((arg) => arg.endsWith(".png")) ?? ""
    expect(imagePath).toMatch(/^\/workspace\/project\/\.aider\.cognia-/)
    expect(mockFiles.get(imagePath)).toBe("iVBORw0KGgo=")
    complete(spawn.id, "Updated", code)
  }
  const result = await adapter.execute(session.id, {
    ...message(),
    content: [
      ...message().content,
      { type: "image", source: { type: "base64", data: "iVBORw0KGgo=", mediaType: "image/png" } },
    ],
  })
  expect(result.success).toBe(code === 0)
  expect(imagePath).not.toBe("")
  expect(mockFiles.has(imagePath)).toBe(false)
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
  expect(fileHost.writeText).toHaveBeenCalledWith(
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
    const adapter = new AiderCliClientAdapter(deps)
    await expect(
      adapter.connect({ ...config, process: { ...config.process!, args } })
    ).rejects.toThrow(/Unsupported/)
  }
  await expect(
    new AiderCliClientAdapter(deps).connect({
      ...config,
      process: { ...config.process!, env: { AIDER_LOAD: "commands.txt" } },
    })
  ).rejects.toThrow(/Unsupported Aider environment/)
})

it("treats slash commands as model task text rather than local CLI commands", async () => {
  const adapter = await connected()
  const session = await adapter.createSession()
  await adapter.execute(session.id, message("/run touch forbidden.txt"), { permissionMode: "plan" })
  expect(fileHost.writeText).toHaveBeenCalledWith(
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
  expect(processHost.kill).toHaveBeenCalledWith(mockSpawned[0].id)
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
  expect(processHost.kill).toHaveBeenCalledWith(mockSpawned[0].id)
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

describe("host ports", () => {
  it("declares per-turn execution semantics", () => {
    expect(new AiderCliClientAdapter(deps).semantics).toBe(AIDER_CLI_EXECUTION_SEMANTICS)
    expect(AIDER_CLI_EXECUTION_SEMANTICS).toMatchObject({
      cancel: { scope: "turn", reconnectsAfterCancel: false },
      resume: "history-replay",
      processModel: "per-turn",
      approvals: "none",
    })
  })

  it("refuses a host without a process plane or workspace files", async () => {
    for (const unavailable of [
      { ...deps, processHost: { ...processHost, available: false } },
      { ...deps, fileHost: { ...fileHost, available: false } },
    ]) {
      const adapter = new AiderCliClientAdapter(unavailable)
      await expect(adapter.connect(config)).rejects.toThrow(/process host with workspace file/)
      expect(adapter.connectionStatus).toBe("error")
    }
  })

  it("probes the bare command name and refuses a missing CLI", async () => {
    processHost.commandExists.mockResolvedValueOnce(false)
    const adapter = new AiderCliClientAdapter(deps)
    await expect(
      adapter.connect({ ...config, process: { ...config.process!, command: "/opt/bin/aider" } })
    ).rejects.toThrow(/not installed/)
    expect(processHost.commandExists).toHaveBeenCalledWith("aider")
  })

  it("kills and fails a turn the host registered under another process id", async () => {
    const adapter = await connected()
    const session = await adapter.createSession()
    processHost.spawn.mockImplementationOnce(async (spec) => {
      mockSpawned.push(spec as (typeof mockSpawned)[number])
      return "host-renamed"
    })
    const result = await adapter.execute(session.id, message())
    expect(result.success).toBe(false)
    expect(result.error).toContain("host-renamed")
    expect(processHost.kill).toHaveBeenCalledWith("host-renamed")
    expect([...mockListeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
  })

  it("passes process diagnostics through the host's redactor", async () => {
    const adapter = await connected()
    const session = await adapter.createSession()
    mockOnSpawn = (spawn) => {
      emit("external-agent://stderr", { agentId: spawn.id, data: "invalid key sk-abc123" })
      emit("external-agent://exit", { agentId: spawn.id, code: 2 })
    }
    const result = await adapter.execute(session.id, message())
    expect(result.error).toContain("[REDACTED]")
    expect(JSON.stringify(result)).not.toContain("sk-abc123")
  })
})
