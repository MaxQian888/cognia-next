import { OmpRpcClientAdapter, type OmpAdapterOptions } from "./rpc-client"
import type {
  AgentProcessHost,
  AgentProcessOutputEvent,
  AgentProcessExitEvent,
} from "@cognia/agent-contracts/host"
import type {
  ExternalAgentConfig,
  ExternalAgentMessage,
  ExternalAgentEvent,
} from "@cognia/agent-contracts/external-agent"

const config = {
  id: "omp-test",
  protocol: "omp-rpc",
  transport: "stdio",
  enabled: true,
  name: "OMP",
} as unknown as ExternalAgentConfig
const message: ExternalAgentMessage = {
  id: "m",
  role: "user",
  timestamp: new Date(),
  content: [{ type: "text", text: "hello" }],
}
function fixture(overrides: Partial<OmpAdapterOptions> = {}) {
  let output: (event: AgentProcessOutputEvent) => void = () => {}
  let exit: (event: AgentProcessExitEvent) => void = () => {}
  let pid = ""
  const commands: Record<string, unknown>[] = []
  const emit = (frame: unknown) =>
    output({ processId: pid, data: Buffer.from(JSON.stringify(frame) + "\n").toString("base64") })
  const host: AgentProcessHost = {
    available: true,
    commandExists: async () => true,
    onStdoutRaw: async (fn) => {
      output = fn
      return () => {
        output = () => {}
      }
    },
    onStdoutLine: async () => () => {},
    onStderr: async () => () => {},
    onExit: async (fn) => {
      exit = fn
      return () => {
        exit = () => {}
      }
    },
    spawn: jest.fn(async (spec) => {
      pid = spec.id
      queueMicrotask(() => {
        emit({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: 1048576,
          maxReassembledBytes: 67108864,
        })
        emit({
          type: "extension_ui_request",
          id: "guard",
          method: "setStatus",
          statusKey: "cognia-omp-ready",
          statusText: "nonce",
        })
      })
      return pid
    }),
    send: jest.fn(async (_id, line) => {
      const f = JSON.parse(line)
      commands.push(f)
      let data: unknown
      if (f.type === "negotiate_protocol") data = { protocolVersion: 2 }
      if (f.type === "get_state")
        data = { sessionId: "native", sessionFile: "/isolated/session.jsonl", isSettled: true }
      if (f.type === "get_session_stats")
        data = { tokens: { input: 0, output: 0, total: 0 }, cost: 0 }
      if (f.type === "get_available_commands")
        data = {
          commands: [
            { name: "local", source: "extension" },
            { name: "skill", source: "skill" },
          ],
        }
      if (f.type === "prompt") data = { agentInvoked: f.message !== "/local" }
      emit({ type: "response", id: f.id, command: f.type, success: true, data })
    }),
    kill: jest.fn(async () => {}),
  }
  const adapter = new OmpRpcClientAdapter({
    processHost: host,
    outboundGate: () => true,
    probeRuntime: async () => ({ version: "18.6.1", command: "/omp" }),
    prepareSession: async () => ({
      cwd: "/isolated",
      sessionDir: "/isolated/sessions",
      trustedExtensionPath: "/isolated/guard.ts",
      nonce: "nonce",
      enforcement: {
        isolatedExtensions: true,
        providerEgressControlled: true,
        rebindingVerified: true,
      },
    }),
    ...overrides,
  })
  return { adapter, host, commands, emit, exit: () => exit({ processId: pid, code: 1 }) }
}
describe("isolated OMP adapter lifecycle", () => {
  it("requires an outbound gate before any host operation", () => {
    expect(() => new OmpRpcClientAdapter({} as never)).toThrow(/outbound/i)
  })
  it("launches raw per-session process only after verified guard preparation", async () => {
    const f = fixture()
    await f.adapter.connect(config)
    const s = await f.adapter.createSession()
    expect(s.metadata).toMatchObject({
      nativeSessionId: "native",
      sessionFile: "/isolated/session.jsonl",
    })
    expect(f.host.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        framing: "raw",
        args: expect.arrayContaining([
          "--mode",
          "rpc",
          "--trusted-extension",
          "/isolated/guard.ts",
        ]),
      })
    )
    await f.adapter.disconnect()
    expect(f.host.kill).toHaveBeenCalledTimes(1)
  })
  it("refuses unverified enforcement before spawning", async () => {
    const f = fixture({
      prepareSession: async () => ({
        cwd: "/a",
        sessionDir: "/a",
        trustedExtensionPath: "/g",
        nonce: "x",
        enforcement: {
          isolatedExtensions: false,
          providerEgressControlled: true,
          rebindingVerified: true,
        },
      }),
    })
    await f.adapter.connect(config)
    await expect(f.adapter.createSession()).rejects.toThrow(/enforcement/i)
    expect(f.host.spawn).not.toHaveBeenCalled()
  })
  it("does not complete on agent_end; completes only the correlated prompt result", async () => {
    const f = fixture()
    await f.adapter.connect(config)
    const s = await f.adapter.createSession()
    const events: ExternalAgentEvent[] = []
    const run = (async () => {
      for await (const e of f.adapter.prompt(s.id, message)) events.push(e)
    })()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const prompt = f.commands.find((c) => c.type === "prompt")!
    f.emit({ type: "agent_end", messages: [] })
    f.emit({
      type: "prompt_result",
      id: "other",
      agentInvoked: true,
      status: "completed",
      sessionSettled: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toHaveLength(0)
    f.emit({
      type: "prompt_result",
      id: prompt.id,
      agentInvoked: true,
      status: "completed",
      sessionSettled: true,
    })
    await run
    expect(events).toEqual([expect.objectContaining({ type: "done", success: true })])
    await f.adapter.disconnect()
  })
  it("kills on cancellation, removes live session and keeps an explicit resume locator", async () => {
    const f = fixture()
    await f.adapter.connect(config)
    const s = await f.adapter.createSession()
    await f.adapter.cancel(s.id)
    expect(f.host.kill).toHaveBeenCalledTimes(1)
    expect(f.adapter.getSession(s.id)).toBeUndefined()
    expect(f.adapter.getResumeLocator(s.id)).toBe("/isolated/session.jsonl")
    await f.adapter.disconnect()
  })
  it("gates the complete prompt and never sends denied payloads", async () => {
    const f = fixture({ outboundGate: (p) => !JSON.stringify(p).includes("SECRET") })
    await f.adapter.connect(config)
    const s = await f.adapter.createSession()
    const run = async () => {
      for await (const event of f.adapter.prompt(s.id, {
        ...message,
        content: [{ type: "text", text: "SECRET" }],
      }))
        void event
    }
    await expect(run()).rejects.toThrow(/outbound/i)
    expect(f.commands.some((c) => c.type === "prompt")).toBe(false)
    await f.adapter.disconnect()
  })
})

describe("OMP package control policies", () => {
  it.each([NaN, 0, -1, 1.5])("rejects invalid buffer limits %s", (limit) => {
    expect(() => fixture({ maxBufferedBytes: limit })).toThrow(/positive integers/)
  })
  it("executes advertised local commands without stealing a prompt stream", async () => {
    const f = fixture()
    await f.adapter.connect(config)
    const s = await f.adapter.createSession()
    const run = (async () => {
      const seen = []
      for await (const event of f.adapter.prompt(s.id, message)) seen.push(event)
      return seen
    })()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(f.adapter.executeSessionCommand(s.id, "/local")).resolves.toEqual({
      mode: "steer",
      disposition: "handled",
    })
    await expect(f.adapter.executeSessionCommand(s.id, "/skill")).rejects.toThrow(
      /advertised extension/
    )
    const prompt = f.commands.find((c) => c.type === "prompt" && c.message === "hello")!
    f.emit({
      type: "prompt_result",
      id: prompt.id,
      agentInvoked: true,
      status: "completed",
      sessionSettled: true,
    })
    expect((await run).filter((e) => e.type === "done")).toHaveLength(1)
    await f.adapter.disconnect()
  })
  it("refuses unverified versions before preparing a process", async () => {
    const prepare = jest.fn()
    const f = fixture({
      prepareSession: prepare,
      probeRuntime: async () => ({ command: "/omp", version: "19.0.0" }),
    })
    await expect(f.adapter.connect(config)).rejects.toThrow(/not been verified/)
    expect(prepare).not.toHaveBeenCalled()
  })
  it("keeps extension dialogs answerable after the local command ACK completes", async () => {
    const f = fixture()
    await f.adapter.connect(config)
    const session = await f.adapter.createSession()
    const observer = jest.fn()
    const unsubscribe = f.adapter.subscribeSessionEvents(session.id, observer)
    try {
      await f.adapter.executeSessionCommand(session.id, "/local")
      f.emit({
        type: "extension_ui_request",
        id: "late-dialog",
        method: "confirm",
        title: "Continue",
      })
      const dialog = observer.mock.calls.find(
        ([event]) => event.type === "elicitation_request"
      )?.[0]
      expect(dialog).toBeDefined()
      await f.adapter.respondToElicitation({
        requestId: dialog.request.id,
        action: "accept",
        content: { confirm: true },
      })
      expect(f.commands).toContainEqual({
        type: "extension_ui_response",
        id: "late-dialog",
        confirmed: true,
      })
    } finally {
      unsubscribe()
      await f.adapter.disconnect()
    }
  })
  it("invalidates native resume identities at account disconnect", async () => {
    const f = fixture()
    await f.adapter.connect(config)
    const s = await f.adapter.createSession()
    await f.adapter.disconnect()
    await f.adapter.connect({ ...config, id: "other-account" })
    await expect(f.adapter.resumeSession(s.id)).rejects.toThrow(/known native/)
    await f.adapter.disconnect()
  })
  it("retires the process when aborting a delegated native shell", async () => {
    const f = fixture()
    await f.adapter.connect(config)
    const s = await f.adapter.createSession()
    await f.adapter.getOmpSession(s.id).abortBash()
    expect(f.host.kill).toHaveBeenCalledTimes(1)
    expect(f.adapter.getSession(s.id)).toBeUndefined()
    await f.adapter.disconnect()
  })
})
