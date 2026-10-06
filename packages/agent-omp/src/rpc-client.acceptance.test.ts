import { OmpRpcClientAdapter, type OmpAdapterOptions, type OmpPreparedSession } from "./rpc-client"
import type { AgentProcessHost, AgentProcessOutputEvent } from "@cognia/agent-contracts/host"
import type { SessionCreateOptions } from "@cognia/agent-contracts/adapter"
import type {
  ExternalAgentConfig,
  ExternalAgentMessage,
  ExternalAgentEvent,
} from "@cognia/agent-contracts/external-agent"

const config = {
  id: "acceptance",
  name: "OMP",
  enabled: true,
  protocol: "omp-rpc",
  transport: "stdio",
} as unknown as ExternalAgentConfig
const message: ExternalAgentMessage = {
  id: "user",
  role: "user",
  timestamp: new Date(),
  content: [{ type: "text", text: "original" }],
}
async function until(check: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (check()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("Expected host action did not occur")
}
function fixture(overrides: Partial<OmpAdapterOptions> = {}) {
  const listeners = new Set<(event: AgentProcessOutputEvent) => void>()
  const commands: { processId: string; frame: Record<string, unknown> }[] = []
  const states = new Map<string, { sessionId: string; sessionFile: string; isSettled: boolean }>()
  const held = new Set<string>()
  const prepare = jest.fn(
    async (
      _config: ExternalAgentConfig,
      _options: SessionCreateOptions
    ): Promise<OmpPreparedSession> => ({
      cwd: "/safe",
      sessionDir: "/safe/sessions",
      trustedExtensionPath: "/safe/guard.ts",
      nonce: "nonce",
      enforcement: {
        isolatedExtensions: true,
        providerEgressControlled: true,
        rebindingVerified: true,
      },
    })
  )
  function emit(processId: string, frame: unknown) {
    const data = Buffer.from(JSON.stringify(frame) + "\n").toString("base64")
    for (const listener of listeners) listener({ processId, data })
  }
  function respond(processId: string, frame: Record<string, unknown>) {
    let data: unknown
    if (frame.type === "negotiate_protocol") data = { protocolVersion: 2 }
    if (frame.type === "get_state") data = { ...states.get(processId)! }
    if (frame.type === "get_session_stats")
      data = { tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }
    if (frame.type === "prompt" || frame.type === "abort_and_prompt") data = { agentInvoked: true }
    if (frame.type === "fork") {
      states.set(processId, {
        sessionId: `${processId}-fork`,
        sessionFile: `/safe/${processId}-fork.jsonl`,
        isSettled: true,
      })
      emit(processId, {
        type: "extension_ui_request",
        id: "guard",
        method: "setStatus",
        statusKey: "cognia-omp-ready",
        statusText: "nonce",
      })
      data = { cancelled: false }
    }
    emit(processId, { type: "response", command: frame.type, id: frame.id, success: true, data })
  }
  const host: AgentProcessHost = {
    available: true,
    commandExists: async () => true,
    onStdoutRaw: async (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onStdoutLine: async () => () => {},
    onStderr: async () => () => {},
    onExit: async () => () => {},
    spawn: jest.fn(async (spec) => {
      states.set(spec.id, {
        sessionId: spec.id,
        sessionFile: `/safe/${spec.id}.jsonl`,
        isSettled: true,
      })
      queueMicrotask(() => {
        emit(spec.id, { type: "ready", supportedProtocolVersions: [1, 2] })
        emit(spec.id, {
          type: "extension_ui_request",
          id: "guard",
          method: "setStatus",
          statusKey: "cognia-omp-ready",
          statusText: "nonce",
        })
      })
      return spec.id
    }),
    send: jest.fn(async (processId, line) => {
      const frame = JSON.parse(line) as Record<string, unknown>
      commands.push({ processId, frame })
      if (!held.has(String(frame.type))) respond(processId, frame)
    }),
    kill: jest.fn(async () => {}),
  }
  const adapter = new OmpRpcClientAdapter({
    processHost: host,
    outboundGate: () => true,
    timeoutMs: 1000,
    probeRuntime: async () => ({ command: "/omp", version: "18.6.1" }),
    prepareSession: prepare,
    ...overrides,
  })
  return { adapter, host, prepare, commands, held, emit, respond }
}

test("fork preserves the parent permission and instruction binding unless explicitly overridden", async () => {
  const f = fixture()
  await f.adapter.connect(config)
  const inherited: SessionCreateOptions = {
    cwd: "/project",
    permissionMode: "plan",
    allowedTools: ["read"],
    systemPrompt: "Project rules",
    context: { project: "isolated" },
  }
  try {
    const parent = await f.adapter.createSession(inherited)
    await f.adapter.forkSession(parent.id, { metadata: { title: "branch" } })
    expect(f.prepare.mock.calls[1][1]).toMatchObject({
      ...inherited,
      metadata: { title: "branch" },
    })
  } finally {
    await f.adapter.disconnect()
  }
})

test("an initializing process occupies one admission slot, not two", async () => {
  const f = fixture({ maxProcesses: 2 })
  await f.adapter.connect(config)
  f.held.add("get_state")
  const first = f.adapter.createSession()
  void first.catch(() => {})
  try {
    await until(() => f.commands.some(({ frame }) => frame.type === "get_state"))
    const second = f.adapter.createSession()
    void second.catch(() => {})
    f.held.delete("get_state")
    for (const { processId, frame } of f.commands.filter(({ frame }) => frame.type === "get_state"))
      f.respond(processId, frame)
    await expect(first).resolves.toMatchObject({ agentId: config.id })
    await expect(second).resolves.toMatchObject({ agentId: config.id })
    expect(f.host.spawn).toHaveBeenCalledTimes(2)
  } finally {
    await f.adapter.disconnect()
  }
})

test("abortAndPrompt cannot bypass a high-level turn reserved during model configuration", async () => {
  const f = fixture()
  await f.adapter.connect(config)
  const session = await f.adapter.createSession()
  f.held.add("set_model")
  const iterator = f.adapter
    .prompt(session.id, message, { model: "provider/model" })
    [Symbol.asyncIterator]()
  const next = iterator.next()
  void next.catch(() => {})
  let replacement:
    ReturnType<ReturnType<OmpRpcClientAdapter["getOmpSession"]>["abortAndPrompt"]> | undefined
  try {
    await until(() => f.commands.some(({ frame }) => frame.type === "set_model"))
    expect(() => {
      replacement = f.adapter.getOmpSession(session.id).abortAndPrompt({ message: "replacement" })
      void replacement.ack.catch(() => {})
      void replacement.result.catch(() => {})
    }).toThrow(/active prompt|reserved|owned/i)
    expect(f.commands.some(({ frame }) => frame.type === "abort_and_prompt")).toBe(false)
  } finally {
    await f.adapter.disconnect()
    await next.catch(() => {})
  }
})

test("a state read started before a transition cannot restore the previous resume identity", async () => {
  const f = fixture()
  await f.adapter.connect(config)
  const session = await f.adapter.createSession()
  const original = f.adapter.getResumeLocator(session.id)
  const client = f.adapter.getOmpSession(session.id)
  f.held.add("get_state")
  const stale = client.getState()
  void stale.catch(() => {})
  try {
    await until(() => f.commands.filter(({ frame }) => frame.type === "get_state").length === 2)
    const old = f.commands.filter(({ frame }) => frame.type === "get_state")[1]
    const transition = client.fork({})
    void transition.catch(() => {})
    await until(() => f.commands.filter(({ frame }) => frame.type === "get_state").length === 3)
    const current = f.commands.filter(({ frame }) => frame.type === "get_state")[2]
    f.respond(current.processId, current.frame)
    await transition
    const nextLocator = f.adapter.getResumeLocator(session.id)
    expect(nextLocator).not.toBe(original)
    f.emit(old.processId, {
      type: "response",
      id: old.frame.id,
      command: "get_state",
      success: true,
      data: { sessionId: old.processId, sessionFile: original, isSettled: true },
    })
    await stale
    expect(f.adapter.getResumeLocator(session.id)).toBe(nextLocator)
  } finally {
    await f.adapter.disconnect()
  }
})

test("a native identity transition invalidates dialogs belonging to the old session", async () => {
  const events: ExternalAgentEvent[] = []
  const f = fixture({ onEvent: (event) => events.push(event) })
  await f.adapter.connect(config)
  const session = await f.adapter.createSession()
  try {
    const processId = f.commands[0].processId
    f.emit(processId, {
      type: "extension_ui_request",
      id: "old-dialog",
      method: "confirm",
      title: "Authorize old session",
    })
    const dialog = events.find((event) => event.type === "elicitation_request")
    if (dialog?.type !== "elicitation_request") throw new Error("Expected dialog")
    await f.adapter.getOmpSession(session.id).fork({})
    await expect(
      f.adapter.respondToElicitation({
        requestId: dialog.request.id,
        action: "accept",
        content: { confirm: true },
      })
    ).rejects.toThrow(/expired|unknown/i)
    expect(f.commands.some(({ frame }) => frame.type === "extension_ui_response")).toBe(false)
  } finally {
    await f.adapter.disconnect()
  }
})

test("reused native dialog IDs after a transition cannot reuse an earlier approval identity", async () => {
  const events: ExternalAgentEvent[] = []
  const f = fixture({ onEvent: (event) => events.push(event) })
  await f.adapter.connect(config)
  const session = await f.adapter.createSession()
  try {
    const processId = f.commands[0].processId
    const show = () =>
      f.emit(processId, {
        type: "extension_ui_request",
        id: "reused",
        method: "confirm",
        title: "Authorize session",
      })
    show()
    const old = events.find((event) => event.type === "elicitation_request")
    if (old?.type !== "elicitation_request") throw new Error("Expected original dialog")
    await f.adapter.respondToElicitation({
      requestId: old.request.id,
      action: "cancel",
      content: null,
    })
    await f.adapter.getOmpSession(session.id).fork({})
    show()
    const dialogs = events.filter((event) => event.type === "elicitation_request")
    expect(dialogs).toHaveLength(2)
    expect(dialogs[1].request.id).not.toBe(old.request.id)
    await expect(
      f.adapter.respondToElicitation({
        requestId: old.request.id,
        action: "accept",
        content: { confirm: true },
      })
    ).rejects.toThrow(/expired|unknown/i)
  } finally {
    await f.adapter.disconnect()
  }
})

test("a native identity transition aborts old host work and suppresses its late result", async () => {
  let signal: AbortSignal | undefined
  let finish!: (result: { content: { type: "text"; text: string }[] }) => void
  const f = fixture({
    hostTool: async (_request, taskSignal) => {
      signal = taskSignal
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  })
  await f.adapter.connect(config)
  const session = await f.adapter.createSession()
  try {
    f.emit(f.commands[0].processId, {
      type: "host_tool_call",
      id: "old-work",
      toolCallId: "old-tool",
      toolName: "read",
      arguments: {},
    })
    await until(() => signal !== undefined)
    await f.adapter.getOmpSession(session.id).fork({})
    expect(signal!.aborted).toBe(true)
    finish({ content: [{ type: "text", text: "old private result" }] })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(
      f.commands.some(({ frame }) => frame.type === "host_tool_result" && frame.id === "old-work")
    ).toBe(false)
  } finally {
    finish?.({ content: [] })
    await f.adapter.disconnect()
  }
})

test("failed host resource release can be retried after confirmed process termination", async () => {
  const f = fixture()
  const release = jest.fn(async () => {})
  release.mockRejectedValueOnce(new Error("Credential cleanup unavailable"))
  const prepare = f.prepare.getMockImplementation()!
  f.prepare.mockImplementationOnce(async (...args) => ({ ...(await prepare(...args)), release }))
  await f.adapter.connect(config)
  const session = await f.adapter.createSession()
  try {
    await expect(f.adapter.closeSession(session.id)).rejects.toThrow(
      "Credential cleanup unavailable"
    )
    expect(() => f.adapter.getOmpSession(session.id)).toThrow(/not running/)
    await f.adapter.closeSession(session.id)
    expect(release).toHaveBeenCalledTimes(2)
    expect(f.host.kill).toHaveBeenCalledTimes(1)
  } finally {
    await f.adapter.disconnect()
  }
})

test("a locally denied transition preserves the unchanged live session", async () => {
  const f = fixture({
    outboundGate: (payload) =>
      !(
        typeof payload === "object" &&
        payload !== null &&
        "type" in payload &&
        payload.type === "fork"
      ),
  })
  await f.adapter.connect(config)
  const session = await f.adapter.createSession()
  try {
    await expect(f.adapter.getOmpSession(session.id).fork({})).rejects.toThrow(/outbound/i)
    expect(f.commands.some(({ frame }) => frame.type === "fork")).toBe(false)
    expect(f.host.kill).not.toHaveBeenCalled()
    expect(f.adapter.getSession(session.id)).toBeDefined()
    await expect(f.adapter.getOmpSession(session.id).getState()).resolves.toMatchObject({
      isSettled: true,
    })
  } finally {
    await f.adapter.disconnect()
  }
})

test("new-session dialogs arriving immediately after the guard handshake survive transition completion", async () => {
  const events: ExternalAgentEvent[] = []
  let enteringNewSession = false
  const f = fixture({
    onEvent: (event) => events.push(event),
    onNativeEvent: (_sessionId, frame) => {
      if (
        enteringNewSession &&
        frame.type === "extension_ui_request" &&
        frame.method === "setStatus" &&
        frame.statusKey === "cognia-omp-ready"
      ) {
        enteringNewSession = false
        f.emit(f.commands[0].processId, {
          type: "extension_ui_request",
          id: "new-dialog",
          method: "confirm",
          title: "New-session request",
        })
      }
    },
  })
  await f.adapter.connect(config)
  const session = await f.adapter.createSession()
  try {
    enteringNewSession = true
    await f.adapter.getOmpSession(session.id).fork({})
    const dialog = events.find((event) => event.type === "elicitation_request")
    if (dialog?.type !== "elicitation_request") throw new Error("Expected new-session dialog")
    await expect(
      f.adapter.respondToElicitation({
        requestId: dialog.request.id,
        action: "accept",
        content: { confirm: true },
      })
    ).resolves.toBeUndefined()
    expect(
      f.commands.some(
        ({ frame }) =>
          frame.type === "extension_ui_response" &&
          frame.id === "new-dialog" &&
          frame.confirmed === true
      )
    ).toBe(true)
  } finally {
    await f.adapter.disconnect()
  }
})
