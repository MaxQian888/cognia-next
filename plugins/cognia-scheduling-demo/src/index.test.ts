import type { PluginContext, PluginTaskContext } from "@cognia/plugin-sdk"

import definition, { HEARTBEAT_HANDLER, manifest } from "./index"
import manifestJson from "../plugin.json"

function makeCtx() {
  const dispose = jest.fn()
  const registerHandler = jest.fn(() => dispose)
  const onDispose = jest.fn()
  const ctx = {
    pluginId: manifestJson.id,
    logger: { info: jest.fn() },
    scheduler: { registerHandler },
    lifecycle: { onDispose, signal: new AbortController().signal },
  } as unknown as PluginContext
  return { ctx, dispose, registerHandler, onDispose }
}

describe("cognia-scheduling-demo", () => {
  it("declares a scheduledTasks contribution with the scheduler capability", () => {
    expect(manifest.id).toBe("cognia-scheduling-demo")
    expect(manifest.capabilities).toContain("scheduler")
    const task = manifestJson.scheduledTasks[0]
    expect(task.handler).toBe(HEARTBEAT_HANDLER)
    expect(task.trigger).toEqual({ type: "interval", seconds: 86400 })
    expect(task.defaultEnabled).toBe(false)
  })

  it("is an opt-in example: no startup activation, labelled as an example", () => {
    // Enabling is what creates the scheduler row, so auto-enabling would put a
    // demo task in every user's /scheduler list.
    expect(manifestJson).not.toHaveProperty("activationEvents")
    expect(manifest.activationEvents ?? []).not.toContain("startup")
    expect(manifestJson.name).toContain("(example)")
    expect(manifestJson.scheduledTasks[0].name).toContain("(example)")
  })

  it("registers its handler on activate and releases it through the lifecycle", async () => {
    const { ctx, dispose, registerHandler, onDispose } = makeCtx()
    await definition.activate?.(ctx)

    expect(registerHandler).toHaveBeenCalledWith(HEARTBEAT_HANDLER, expect.any(Function))
    expect(onDispose).toHaveBeenCalledWith(dispose, expect.any(String))

    const [, handler] = registerHandler.mock.calls[0] as unknown as [
      string,
      (args: Record<string, unknown>, context: PluginTaskContext) => Promise<unknown>,
    ]
    await expect(handler({}, {} as PluginTaskContext)).resolves.toEqual({ success: true })
    expect(ctx.logger.info).toHaveBeenCalledWith("scheduling-demo heartbeat fired")
  })
})
