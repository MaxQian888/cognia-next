import { OmpRpcClientAdapter, type OmpAdapterOptions } from "./rpc-client"
import type {
  AgentProcessHost,
  AgentProcessOutputEvent,
  AgentProcessExitEvent,
  Unsubscribe,
} from "@cognia/agent-contracts/host"
import type {
  ExternalAgentConfig,
  ExternalAgentMessage,
} from "@cognia/agent-contracts/external-agent"

const config = {
  id: "lifecycle",
  name: "OMP",
  protocol: "omp-rpc",
  transport: "stdio",
  enabled: true,
} as unknown as ExternalAgentConfig
const message: ExternalAgentMessage = {
  id: "user",
  role: "user",
  timestamp: new Date(),
  content: [{ type: "text", text: "hello" }],
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function until(check: () => boolean) {
  for (let i = 0; i < 30; i++) {
    if (check()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("Expected observable host action did not occur")
}
function fixture(overrides: Partial<OmpAdapterOptions> = {}) {
  const stdout = new Set<(event: AgentProcessOutputEvent) => void>()
  const exits = new Set<(event: AgentProcessExitEvent) => void>()
  let pid = ""
  const commands: Record<string, unknown>[] = []
  const held = new Set<string>()
  const release = jest.fn(async () => {})
  const stdoutUnsubscribe = jest.fn()
  const exitUnsubscribe = jest.fn()
  const emitMany = (...frames: unknown[]) => {
    const data = Buffer.from(frames.map((frame) => JSON.stringify(frame) + "\n").join("")).toString(
      "base64"
    )
    for (const listener of [...stdout]) listener({ processId: pid, data })
  }
  const state = { sessionId: "native", sessionFile: "/safe/native.jsonl", isSettled: true }
  function respond(frame: Record<string, unknown>, data?: unknown) {
    emitMany({ type: "response", id: frame.id, command: frame.type, success: true, data })
  }
  const host: AgentProcessHost = {
    available: true,
    commandExists: async () => true,
    onStdoutRaw: jest.fn(async (listener) => {
      stdout.add(listener)
      return () => {
        stdout.delete(listener)
        stdoutUnsubscribe()
      }
    }),
    onStdoutLine: async () => () => {},
    onStderr: async () => () => {},
    onExit: jest.fn(async (listener) => {
      exits.add(listener)
      return () => {
        exits.delete(listener)
        exitUnsubscribe()
      }
    }),
    spawn: jest.fn(async (spec) => {
      pid = spec.id
      queueMicrotask(() =>
        emitMany(
          { type: "ready", supportedProtocolVersions: [1, 2] },
          {
            type: "extension_ui_request",
            id: "guard",
            method: "setStatus",
            statusKey: "cognia-omp-ready",
            statusText: "nonce",
          }
        )
      )
      return pid
    }),
    send: jest.fn(async (_id, line) => {
      const frame = JSON.parse(line)
      commands.push(frame)
      if (held.has(frame.type)) return
      let data: unknown
      if (frame.type === "negotiate_protocol") data = { protocolVersion: 2 }
      if (frame.type === "get_state") data = { ...state }
      if (frame.type === "get_session_stats")
        data = { tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }
      if (frame.type === "prompt") data = { agentInvoked: true }
      if (frame.type === "open_session")
        data = {
          cancelled: false,
          resumed: true,
          sessionId: state.sessionId,
          sessionFile: state.sessionFile,
        }
      respond(frame, data)
    }),
    kill: jest.fn(async () => {}),
  }
  const adapter = new OmpRpcClientAdapter({
    processHost: host,
    outboundGate: () => true,
    timeoutMs: 100,
    probeRuntime: async () => ({ version: "18.6.1", command: "/omp" }),
    prepareSession: async () => ({
      cwd: "/safe",
      sessionDir: "/safe/sessions",
      trustedExtensionPath: "/safe/guard.ts",
      nonce: "nonce",
      enforcement: {
        isolatedExtensions: true,
        providerEgressControlled: true,
        rebindingVerified: true,
      },
      release,
    }),
    ...overrides,
  })
  const exit = () => {
    for (const listener of [...exits]) listener({ processId: pid, code: 1 })
  }
  return {
    adapter,
    host,
    commands,
    held,
    respond,
    emitMany,
    state,
    release,
    stdout,
    exits,
    stdoutUnsubscribe,
    exitUnsubscribe,
    exit,
  }
}
async function started(overrides: Partial<OmpAdapterOptions> = {}) {
  const f = fixture(overrides)
  await f.adapter.connect(config)
  const session = await f.adapter.createSession()
  return { ...f, session }
}
function result(id: unknown, sessionSettled = true, status: "completed" | "aborted" = "completed") {
  return { type: "prompt_result", id, agentInvoked: true, status, sessionSettled }
}

test("disconnect invalidates a slow probe and concurrent connect cannot race it", async () => {
  const probe = deferred<{ command: string; version: string }>()
  const f = fixture({ probeRuntime: () => probe.promise })
  const connect = f.adapter.connect(config)
  await expect(f.adapter.connect(config)).rejects.toThrow(/progress/)
  await f.adapter.disconnect()
  probe.resolve({ command: "/omp", version: "18.6.1" })
  await expect(connect).rejects.toThrow(/interrupted/)
  expect(f.adapter.isConnected()).toBe(false)
  await expect(f.adapter.createSession()).rejects.toThrow(/not connected/)
  expect(f.host.spawn).not.toHaveBeenCalled()
})

test.each(["onStdoutRaw", "onExit"] as const)(
  "late %s registration is removed without spawning after disconnect",
  async (method) => {
    const f = fixture()
    const registration = deferred<Unsubscribe>()
    const lateUnsubscribe = jest.fn()
    const registrar = jest.fn(() => registration.promise)
    f.host[method] = registrar
    await f.adapter.connect(config)
    const creating = f.adapter.createSession()
    await until(() => registrar.mock.calls.length === 1)
    await f.adapter.disconnect()
    registration.resolve(lateUnsubscribe)
    await expect(creating).rejects.toThrow(/interrupted/)
    expect(lateUnsubscribe).toHaveBeenCalledTimes(1)
    expect(f.host.spawn).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledTimes(1)
    expect(f.stdout.size).toBe(0)
    expect(f.exits.size).toBe(0)
  }
)

test("disconnect during launch environment lookup cannot resurrect a released process", async () => {
  const environment = deferred<Record<string, string>>()
  const resolver = jest.fn(() => environment.promise)
  const f = fixture({ resolveLaunchEnvironment: resolver })
  await f.adapter.connect(config)
  const creating = f.adapter.createSession()
  await until(() => resolver.mock.calls.length === 1)
  await f.adapter.disconnect()
  environment.resolve({ SAFE: "value" })
  await expect(creating).rejects.toThrow(/interrupted/)
  expect(f.host.spawn).not.toHaveBeenCalled()
  expect(f.stdoutUnsubscribe).toHaveBeenCalledTimes(1)
  expect(f.exitUnsubscribe).toHaveBeenCalledTimes(1)
  expect(f.release).toHaveBeenCalledTimes(1)
})

test("reserves the prompt before awaited model configuration", async () => {
  const f = await started()
  f.held.add("set_model")
  const first = f.adapter
    .prompt(f.session.id, message, { model: "provider/model" })
    [Symbol.asyncIterator]()
  const next = first.next()
  await until(() => f.commands.some((command) => command.type === "set_model"))
  const second = f.adapter.prompt(f.session.id, message)[Symbol.asyncIterator]()
  await expect(second.next()).rejects.toThrow(/active prompt/)
  expect(f.commands.filter((command) => command.type === "get_session_stats")).toHaveLength(0)
  f.respond(
    f.commands.find((command) => command.type === "set_model")!,
    {}
  )
  await until(() => f.commands.some((command) => command.type === "prompt"))
  await f.adapter.cancel(f.session.id)
  await expect(next).rejects.toThrow(/cancelled/)
  await f.adapter.disconnect()
})

test("consumer overflow kills once without recursively enqueueing another error", async () => {
  const f = await started({ maxBufferedEvents: 1 })
  const stream = f.adapter.prompt(f.session.id, message)[Symbol.asyncIterator]()
  const next = stream.next()
  await until(() => f.commands.some((command) => command.type === "prompt"))
  expect(() =>
    f.emitMany(
      { type: "command_output", text: "one" },
      { type: "command_output", text: "two" },
      { type: "command_output", text: "three" }
    )
  ).not.toThrow()
  await expect(next).rejects.toThrow(/overflow/)
  await until(() => f.release.mock.calls.length === 1)
  expect(f.host.kill).toHaveBeenCalledTimes(1)
  expect(f.stdout.size).toBe(0)
  await f.adapter.disconnect()
})

test("same-read settled event wins over the earlier prompt result's busy snapshot", async () => {
  const f = await started()
  const client = f.adapter.getOmpSession(f.session.id)
  const ticket = client.prompt({ message: "run" })
  await ticket.ack
  f.emitMany(result(ticket.id, false), { type: "session_settled" })
  await ticket.result
  await Promise.resolve()
  expect(f.adapter.getSession(f.session.id)?.status).toBe("idle")
  await expect(client.openSession({ sessionDir: "/safe/sessions" })).resolves.toMatchObject({
    sessionId: "native",
  })
  await f.adapter.disconnect()
})

test("opening the same native identity requires no second guard handshake", async () => {
  const f = await started()
  await expect(
    f.adapter.getOmpSession(f.session.id).openSession({ sessionDir: "/safe/sessions" })
  ).resolves.toMatchObject({ sessionId: "native" })
  expect(f.host.kill).not.toHaveBeenCalled()
  expect(f.adapter.getResumeLocator(f.session.id)).toBe("/safe/native.jsonl")
  await f.adapter.disconnect()
})

test("abortAndPrompt replaces an active ticket and old completion cannot clear the replacement", async () => {
  const f = await started()
  const client = f.adapter.getOmpSession(f.session.id)
  const first = client.prompt({ message: "first" })
  await first.ack
  const second = client.abortAndPrompt({ message: "replacement" })
  await second.ack
  f.emitMany(result(first.id, false, "aborted"))
  await first.result
  expect(f.adapter.getSession(f.session.id)?.status).toBe("executing")
  expect(() => client.prompt({ message: "third" })).toThrow(/active prompt/)
  f.emitMany(result(second.id, true))
  await second.result
  await Promise.resolve()
  expect(f.adapter.getSession(f.session.id)?.status).toBe("idle")
  expect(f.commands.filter((command) => command.type === "abort_and_prompt")).toHaveLength(1)
  await f.adapter.disconnect()
})

test("failed termination retains guard resources until an actual process exit", async () => {
  const f = await started()
  jest.mocked(f.host.kill).mockRejectedValueOnce(new Error("Kill failed"))
  await expect(f.adapter.closeSession(f.session.id)).rejects.toThrow("Kill failed")
  expect(f.release).not.toHaveBeenCalled()
  expect(f.exits.size).toBe(1)
  expect(() => f.adapter.getOmpSession(f.session.id)).toThrow(/not running/)
  f.exit()
  await until(() => f.release.mock.calls.length === 1)
  expect(f.exits.size).toBe(0)
  expect(f.stdout.size).toBe(0)
  await f.adapter.disconnect()
})

test("an exit observed during a pending kill still releases resources if kill later rejects", async () => {
  const f = await started()
  let rejectKill!: (error: Error) => void
  jest.mocked(f.host.kill).mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        rejectKill = reject
      })
  )
  const closing = f.adapter.closeSession(f.session.id)
  await until(() => jest.mocked(f.host.kill).mock.calls.length === 1)
  f.exit()
  rejectKill(new Error("Process already exited"))
  await closing.catch(() => {})
  await until(() => f.release.mock.calls.length === 1)
  expect(f.exits.size).toBe(0)
  expect(f.adapter.getSession(f.session.id)).toBeUndefined()
  await f.adapter.disconnect()
})

test("late response after request timeout cannot replace a newer adopted session snapshot", async () => {
  const f = await started({ timeoutMs: 20 })
  const client = f.adapter.getOmpSession(f.session.id)
  f.held.add("get_state")
  const old = client.getState()
  await until(() => f.commands.filter((command) => command.type === "get_state").length === 2)
  const oldFrame = f.commands.filter((command) => command.type === "get_state")[1]
  await expect(old).rejects.toThrow(/timed out/)
  f.held.delete("get_state")
  f.state.sessionFile = "/safe/new.jsonl"
  await client.getState()
  f.respond(oldFrame, { ...f.state, sessionFile: "/safe/old.jsonl" })
  expect(f.adapter.getResumeLocator(f.session.id)).toBe("/safe/new.jsonl")
  expect(f.host.kill).not.toHaveBeenCalled()
  await f.adapter.disconnect()
})

test("cancelled prompt ignores late completion after listeners are removed", async () => {
  const f = await started()
  const ticket = f.adapter.getOmpSession(f.session.id).prompt({ message: "run" })
  await ticket.ack
  await f.adapter.cancel(f.session.id)
  await expect(ticket.result).rejects.toThrow(/cancelled/)
  f.emitMany(result(ticket.id, true))
  expect(f.adapter.getSession(f.session.id)).toBeUndefined()
  expect(f.release).toHaveBeenCalledTimes(1)
  expect(f.host.kill).toHaveBeenCalledTimes(1)
  await f.adapter.disconnect()
})
