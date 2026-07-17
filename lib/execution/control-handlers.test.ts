import { installExecutionRunControlHandlers, registerAgentRunController } from "./control-handlers"

describe("execution source control handlers", () => {
  it("stops only the addressed agent run", async () => {
    const first = new AbortController()
    const second = new AbortController()
    const unregisterFirst = registerAgentRunController("run-1", first)
    const unregisterSecond = registerAgentRunController("run-2", second)
    const installed = installExecutionRunControlHandlers()

    await installed.agent({
      runId: "run-1",
      action: "stop",
      idempotencyKey: "stop-1",
      expectedRevision: 0,
      actor: {},
    })

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    unregisterFirst()
    unregisterSecond()
    installed.dispose()
  })
})
