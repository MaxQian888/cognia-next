import { IsolatedAcpAdapter, isolatedAcpExtension } from "./isolated-adapter"
import type { AcpClientAdapter } from "./client"

it("reconciles an exited conversation without closing its sibling or discovery", async () => {
  const clients = ["discovery", "a", "b"].map((id) => ({
    connectionStatus: "connected",
    connect: jest.fn(),
    disconnect: jest.fn(),
    createSession: jest.fn().mockResolvedValue({ id, agentId: "child" }),
    getSession: jest.fn().mockReturnValue({ id, agentId: "child" }),
  }))
  let next = 1
  const adapter = new IsolatedAcpAdapter(
    clients[0] as unknown as AcpClientAdapter,
    () => clients[next++] as unknown as AcpClientAdapter
  )
  await adapter.connect({
    id: "agent",
    protocol: "acp",
    transport: "stdio",
    process: { command: "test", args: [] },
  } as never)
  await Promise.all([adapter.createSession(), adapter.createSession()])
  expect(isolatedAcpExtension.resolve(adapter)).toBe(adapter)
  expect(await adapter.handleProcessExit("agent:acp:1")).toEqual(["a"])
  expect(adapter.getSessions().map((s) => s.id)).toEqual(["b"])
  expect(clients[1].disconnect).toHaveBeenCalledTimes(1)
  expect(clients[2].disconnect).not.toHaveBeenCalled()
  expect(clients[0].disconnect).toHaveBeenCalledTimes(1)
  await adapter.disconnect()
})
