/** @jest-environment node */
import type { AgentProcessHost } from "@cognia/agent-contracts/host"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import {
  createCrushSocketBridge,
  encodeCrushSocketFrame,
  type CrushSocketFrame,
} from "./socket-bridge"
function setup() {
  let line: Parameters<AgentProcessHost["onStdoutLine"]>[0] = () => {},
    id = ""
  const off = jest.fn(),
    sent: CrushSocketFrame[] = []
  const emit = (frame: CrushSocketFrame) =>
    line({ processId: id, data: encodeCrushSocketFrame(frame) })
  const host: AgentProcessHost = {
    available: true,
    commandExists: async () => true,
    spawn: jest.fn(async (spec) => {
      id = spec.id
      return id
    }),
    kill: jest.fn(async () => {}),
    send: jest.fn(async (_, raw) => {
      const f = JSON.parse(raw) as CrushSocketFrame
      sent.push(f)
      if (f.type === "init") emit({ type: "ready" })
      if (f.type === "request") {
        emit({ type: "head", requestId: f.requestId, status: 200, headers: {} })
        emit({ type: "chunk", requestId: f.requestId, seq: 0, data: btoa("body") })
      }
      if (f.type === "ack") emit({ type: "end", requestId: f.requestId })
    }),
    onStdoutLine: async (cb) => {
      line = cb
      return off
    },
    onStdoutRaw: async () => off,
    onStderr: async () => off,
    onExit: async () => off,
  }
  const gate = jest.fn(() => true),
    bridge = createCrushSocketBridge({
      processHost: host,
      outboundGate: gate,
      resolveBridgeLaunch: async () => ({ command: "node", args: ["/verified/crush-bridge.cjs"] }),
    })
  const config = {
    id: "crush",
    process: { command: "crush", cwd: "/workspace" },
  } as ExternalAgentConfig
  return { bridge, config, host, off, sent, gate }
}
it("routes HTTP exclusively through an owned private-socket process lease", async () => {
  const s = setup()
  const service = await s.bridge.launch(s.config, "/workspace")
  expect(s.sent[0]).toMatchObject({ type: "init", command: "crush", cwd: "/workspace" })
  await expect(s.bridge.fetch("http://127.0.0.1/v1/health")).rejects.toThrow(/owned socket lease/)
  const result = await s.bridge.fetch(service.endpoint + "/v1/health", { headers: service.headers })
  expect(await result.text()).toBe("body")
  expect(s.sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: "ack", seq: 0 })]))
  await service.close()
  expect(s.host.kill).toHaveBeenCalledTimes(1)
  expect(s.off).toHaveBeenCalledTimes(3)
  await expect(
    s.bridge.fetch(service.endpoint + "/v1/health", { headers: service.headers })
  ).rejects.toThrow(/owned socket lease/)
})
it("rejects public URLs and PII without forwarding a request", async () => {
  const s = setup(),
    service = await s.bridge.launch(s.config, "/workspace")
  await expect(
    s.bridge.fetch("https://example.com/v1/health", { headers: service.headers })
  ).rejects.toThrow(/owned socket lease/)
  s.gate.mockReturnValue(false)
  await expect(
    s.bridge.fetch(service.endpoint + "/v1/agent", {
      method: "POST",
      body: "private",
      headers: service.headers,
    })
  ).rejects.toThrow(/PII/)
  expect(s.sent.filter((f) => f.type === "request")).toHaveLength(0)
  await service.close()
})

it("refuses using the verified Node bridge as a generic executable launcher", async () => {
  const s = setup()
  await expect(
    s.bridge.launch(
      { ...s.config, process: { command: "/bin/sh", args: [] } } as never,
      "/workspace"
    )
  ).rejects.toThrow(/local process/)
  expect(s.host.spawn).not.toHaveBeenCalled()
})
