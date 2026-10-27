/** @jest-environment node */
import type { AgentFileHost, AgentProcessHost } from "@cognia/agent-contracts/host"
import type {
  ExternalAgentConfig,
  ExternalAgentEvent,
} from "@cognia/agent-contracts/external-agent"
import { ContinueAdapter } from "./client"

function setup(autoExit = true) {
  let raw: Parameters<AgentProcessHost["onStdoutRaw"]>[0] = () => {},
    exit: Parameters<AgentProcessHost["onExit"]>[0] = () => {}
  const off = jest.fn(),
    disk = new Map<string, string>()
  const fileHost = {
    available: true,
    isWithinRoot: (p: string, r: string) => p.startsWith(r + "/"),
    readText: jest.fn(async (p: string) => {
      const value = disk.get(p)
      if (value === undefined) throw new Error("missing")
      return value
    }),
    writeText: jest.fn(async (p: string, v: string) => {
      disk.set(p, v)
    }),
  } as unknown as AgentFileHost
  const processHost: AgentProcessHost = {
    available: true,
    commandExists: async () => true,
    onStdoutLine: async () => off,
    onStdoutRaw: async (cb) => {
      raw = cb
      return off
    },
    onStderr: async () => off,
    onExit: async (cb) => {
      exit = cb
      return off
    },
    send: async () => {},
    kill: jest.fn(async () => {}),
    spawn: jest.fn(async (spec) => {
      if (autoExit) {
        raw({
          processId: spec.id,
          data: btoa(
            JSON.stringify({ response: "answer", status: "success", toolCalls: ["model-data"] })
          ),
        })
        exit({ processId: spec.id, code: 0 })
      }
      return spec.id
    }),
  }
  const gate = jest.fn(() => true)
  const adapter = new ContinueAdapter({
    processHost,
    fileHost,
    outboundGate: gate,
    redactDiagnostic: (s) => s,
  })
  const config = {
    id: "cn",
    protocol: "continue-cli",
    transport: "stdio",
    process: { command: "cn", cwd: "/workspace" },
  } as ExternalAgentConfig
  return { adapter, processHost, fileHost, disk, off, gate, config }
}
async function collect(source: AsyncIterable<ExternalAgentEvent>) {
  const events: ExternalAgentEvent[] = []
  for await (const e of source) events.push(e)
  return events
}
const message = {
  id: "user",
  timestamp: new Date(),
  role: "user" as const,
  content: [{ type: "text" as const, text: "hello" }],
}

describe("Continue headless lifecycle", () => {
  it("uses readonly default, subscribes before spawn, and replays only its bound history", async () => {
    const s = setup()
    await s.adapter.connect(s.config)
    const session = await s.adapter.createSession()
    const events = await collect(s.adapter.prompt(session.id, message))
    expect(events.at(-1)).toMatchObject({ type: "done", success: true })
    expect(events.some((e) => e.type === "tool_use_start")).toBe(false)
    const spawn = jest.mocked(s.processHost.spawn)
    expect(spawn.mock.calls[0][0].args).toEqual(
      expect.arrayContaining(["-p", "--format", "json", "--readonly"])
    )
    expect(s.off).toHaveBeenCalledTimes(3)
    await s.adapter.closeSession(session.id)
    await s.adapter.resumeSession(session.id)
    await collect(s.adapter.prompt(session.id, message))
    expect(spawn.mock.calls[1][0].args?.at(-1)).toContain("Prior conversation")
    expect(spawn.mock.calls[1][0].args).not.toContain("--resume")
    await s.adapter.disconnect()
  })
  it("cancels even when a killed host process never emits exit", async () => {
    const s = setup(false)
    await s.adapter.connect(s.config)
    const session = await s.adapter.createSession()
    const turn = s.adapter.prompt(session.id, message)[Symbol.asyncIterator]()
    expect((await turn.next()).value).toMatchObject({ type: "message_start" })
    const pending = turn.next()
    await s.adapter.cancel(session.id)
    expect((await pending).value).toMatchObject({
      type: "done",
      success: false,
      stopReason: "cancelled",
    })
    await turn.return?.()
    expect(s.processHost.kill).toHaveBeenCalled()
    await s.adapter.disconnect()
  })
  it("blocks PII and unsupported authority before spawn", async () => {
    const s = setup()
    await s.adapter.connect(s.config)
    const session = await s.adapter.createSession()
    s.gate.mockReturnValue(false)
    await expect(collect(s.adapter.prompt(session.id, message))).rejects.toThrow(/PII/)
    expect(s.processHost.spawn).not.toHaveBeenCalled()
    s.gate.mockReturnValue(true)
    await expect(
      collect(s.adapter.prompt(session.id, message, { allowedTools: ["shell"] }))
    ).rejects.toThrow(/allowlists/)
    await s.adapter.disconnect()
  })
})
