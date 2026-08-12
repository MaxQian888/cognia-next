import type { AgentSessionControlPort } from "./agent-session-control-port"

describe("AgentSessionControlPort", () => {
  it("accepts a transport adapter directly without a conversion layer", async () => {
    const interrupt = jest.fn(async () => undefined)
    const port: AgentSessionControlPort = {
      sessionId: "session-1",
      spec: { capabilities: { effective: [] } } as unknown as AgentSessionControlPort["spec"],
      events: async () => () => undefined,
      interrupt,
      cancel: async () => undefined,
      compact: async () => undefined,
      resolvePermission: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      steer: async () => ({ accepted: true }),
      control: async <T>() => undefined as T,
    }

    await port.interrupt()
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(port.sessionId).toBe("session-1")
  })
})
