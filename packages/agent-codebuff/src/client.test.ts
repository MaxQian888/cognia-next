/** @jest-environment node */
import type {
  AgentApprovalPolicy,
  AgentFileHost,
  AgentProcessHost,
} from "@cognia/agent-contracts/host"
import type {
  ExternalAgentConfig,
  ExternalAgentEvent,
} from "@cognia/agent-contracts/external-agent"
import { CodebuffAdapter } from "./client"
import { encodeBridgeFrame, type BridgeFrame } from "./bridge-protocol"
function setup(autoComplete = true, approvalPolicy: AgentApprovalPolicy = () => null) {
  let line: Parameters<AgentProcessHost["onStdoutLine"]>[0] = () => {},
    processId = "",
    turnId = ""
  const disk = new Map<string, string>(),
    off = jest.fn(),
    sent: BridgeFrame[] = []
  const emit = (frame: BridgeFrame) => line({ processId, data: encodeBridgeFrame(frame) })
  const fileHost = {
    available: true,
    readText: async (p: string) => disk.get(p)!,
    writeText: async (p: string, v: string) => {
      disk.set(p, v)
    },
  } as unknown as AgentFileHost
  const processHost: AgentProcessHost = {
    available: true,
    commandExists: async () => true,
    onStdoutLine: async (cb) => {
      line = cb
      return off
    },
    onStdoutRaw: async () => off,
    onStderr: async () => off,
    onExit: async () => off,
    kill: jest.fn(async () => {}),
    spawn: jest.fn(async (spec) => {
      processId = spec.id
      return spec.id
    }),
    send: jest.fn(async (_, raw) => {
      const f = JSON.parse(raw) as BridgeFrame
      sent.push(f)
      if (f.type === "init") emit({ type: "ready" })
      if (f.type === "run") {
        turnId = String(f.turnId)
        if (autoComplete) {
          emit({ type: "chunk", turnId, chunk: "answer" })
          emit({
            type: "result",
            turnId,
            state: { sessionState: { prior: true }, output: { type: "lastMessage", value: [] } },
          })
        }
      }
    }),
  }
  const gate = jest.fn(() => true),
    fetch = jest.fn(async () => Response.json({})),
    launch = jest.fn(async () => ({
      command: "node",
      args: ["/verified/node-bridge.cjs"],
      networkIsolated: true as const,
    }))
  const adapter = new CodebuffAdapter({
    processHost,
    fileHost,
    fetch,
    outboundGate: gate,
    redactDiagnostic: (s) => s,
    approvalPolicy,
    resolveBridgeLaunch: launch,
  })
  const config = {
    id: "cb",
    protocol: "codebuff-sdk",
    transport: "stdio",
    process: { command: "node", cwd: "/workspace" },
  } as ExternalAgentConfig
  return {
    adapter,
    config,
    processHost,
    off,
    disk,
    sent,
    emit,
    gate,
    fetch,
    launch,
    turn: () => turnId,
  }
}
const message = {
  id: "user",
  timestamp: new Date(),
  role: "user" as const,
  content: [{ type: "text" as const, text: "hello" }],
}
async function collect(iter: AsyncIterable<ExternalAgentEvent>) {
  const events: ExternalAgentEvent[] = []
  for await (const e of iter) events.push(e)
  return events
}
it("starts only an isolated verified bridge and persists the published RunState for resume", async () => {
  const s = setup()
  await s.adapter.connect(s.config)
  const session = await s.adapter.createSession()
  const events = await collect(s.adapter.prompt(session.id, message))
  expect(events.at(-1)).toMatchObject({ type: "done", success: true })
  expect(jest.mocked(s.processHost.spawn).mock.calls[0][0].sandboxPolicy).toMatchObject({
    network: "off",
    readableScope: "workspace",
  })
  await s.adapter.closeSession(session.id)
  await s.adapter.resumeSession(session.id)
  await collect(s.adapter.prompt(session.id, message))
  expect(s.sent.filter((f) => f.type === "run")[1].previousRun).toMatchObject({
    sessionState: { prior: true },
  })
  await s.adapter.disconnect()
  expect(s.off).toHaveBeenCalledTimes(6)
})
it("fails closed on unavailable OS isolation and unsupported MCP", async () => {
  const s = setup()
  await s.adapter.connect(s.config)
  await expect(
    s.adapter.createSession({ mcpServers: [{ name: "x", command: "x", args: [], env: [] }] })
  ).rejects.toThrow(/MCP/)
  s.launch.mockResolvedValue({ command: "node", args: [], networkIsolated: false as true })
  await expect(s.adapter.createSession()).rejects.toThrow(/isolation/)
  expect(s.processHost.spawn).not.toHaveBeenCalled()
})
it("brokers approvals and blocks network payloads before the host fetch", async () => {
  const s = setup(false)
  await s.adapter.connect(s.config)
  const session = await s.adapter.createSession(),
    iterator = s.adapter.prompt(session.id, message)[Symbol.asyncIterator]()
  await iterator.next()
  s.emit({
    type: "host-request",
    kind: "approval",
    requestId: "write",
    name: "write_file",
    input: { path: "/workspace/a" },
  })
  expect((await iterator.next()).value).toMatchObject({ type: "permission_request" })
  await s.adapter.respondToPermission(session.id, { requestId: "write", granted: false })
  expect(s.sent).toContainEqual({ type: "host-result", requestId: "write", result: false })
  s.gate.mockClear()
  s.gate.mockReturnValue(false)
  s.emit({
    type: "host-request",
    kind: "network",
    requestId: "net",
    url: "https://www.codebuff.com/api/v1/test-model",
    method: "POST",
    headers: {},
    body: "PII",
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(s.gate).toHaveBeenCalled()
  expect(s.fetch).not.toHaveBeenCalled()
  expect(s.sent).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "network-error", requestId: "net" })])
  )
  s.gate.mockReturnValue(true)
  s.emit({
    type: "host-request",
    kind: "network",
    requestId: "net-allowed",
    url: "https://www.codebuff.com/api/v1/test-model",
    method: "POST",
    headers: {},
    body: "safe",
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(s.fetch).toHaveBeenCalledWith(
    "https://www.codebuff.com/api/v1/test-model",
    expect.objectContaining({ body: "safe" })
  )
  await s.adapter.cancel(session.id)
  expect((await iterator.next()).value).toMatchObject({ type: "done", stopReason: "cancelled" })
  await iterator.return?.()
  s.gate.mockReturnValue(true)
  await s.adapter.resumeSession(session.id)
  expect(s.processHost.spawn).toHaveBeenCalledTimes(2)
  await s.adapter.disconnect()
})

it("preserves mandatory approval for read-only tools in plan mode and still denies writes", async () => {
  const s = setup(false, () => "ask")
  await s.adapter.connect(s.config)
  const session = await s.adapter.createSession({ permissionMode: "plan" })
  const iterator = s.adapter.prompt(session.id, message)[Symbol.asyncIterator]()
  await iterator.next()
  s.emit({
    type: "host-request",
    kind: "approval",
    requestId: "mandatory-read",
    name: "read_files",
    input: { paths: ["/workspace/a"] },
  })
  expect((await iterator.next()).value).toMatchObject({
    type: "permission_request",
    request: expect.objectContaining({ requestId: "mandatory-read" }),
  })
  expect(s.sent).not.toContainEqual(
    expect.objectContaining({ type: "host-result", requestId: "mandatory-read" })
  )
  await s.adapter.respondToPermission(session.id, { requestId: "mandatory-read", granted: false })
  expect(s.sent).toContainEqual({ type: "host-result", requestId: "mandatory-read", result: false })
  s.emit({
    type: "host-request",
    kind: "approval",
    requestId: "plan-write",
    name: "write_file",
    input: { path: "/workspace/a" },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(s.sent).toContainEqual({ type: "host-result", requestId: "plan-write", result: false })
  await s.adapter.cancel(session.id)
  await iterator.next()
  await iterator.return?.()
  await s.adapter.disconnect()
})
