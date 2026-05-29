import definition from "./index"
import manifest from "../plugin.json"

describe("cognia-scheduling-demo", () => {
  it("declares a scheduledTasks contribution with the scheduler capability", () => {
    expect(manifest.id).toBe("cognia-scheduling-demo")
    expect(manifest.capabilities).toContain("scheduler")
    expect(manifest.scheduledTasks).not.toHaveLength(0)
    const task = manifest.scheduledTasks[0]
    expect(task.handler).toBe("demoHeartbeat")
    expect(task.trigger).toEqual({ type: "interval", seconds: 86400 })
  })

  it("registers its handler on activate and disposes it on deactivate", async () => {
    const dispose = jest.fn()
    const registerHandler = jest.fn(() => dispose)
    const ctx = {
      pluginId: manifest.id,
      logger: { info: jest.fn() },
      scheduler: { registerHandler },
    } as never

    await definition.activate?.(ctx)
    expect(registerHandler).toHaveBeenCalledWith("demoHeartbeat", expect.any(Function))

    // The registered handler is benign and resolves ok.
    const handler = registerHandler.mock.calls[0][1] as () => Promise<{ ok: boolean }>
    await expect(handler()).resolves.toEqual({ ok: true })

    await definition.deactivate?.(ctx)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("tolerates a host without a scheduler API", async () => {
    const ctx = { pluginId: manifest.id, logger: { info: jest.fn() } } as never
    await expect(definition.activate?.(ctx)).resolves.toBeUndefined()
    await expect(definition.deactivate?.(ctx)).resolves.toBeUndefined()
  })
})
