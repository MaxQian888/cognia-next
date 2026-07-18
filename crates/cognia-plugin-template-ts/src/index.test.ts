/** @jest-environment jsdom */

import type { PluginContext, PluginHooks } from "@cognia/plugin-sdk"
import templatePlugin from "./index"

interface RegisteredTool {
  name: string
  pluginId: string
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

function makeCtx() {
  const registeredTools: RegisteredTool[] = []
  const showToast = jest.fn()
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-plugin-template-ts",
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as never,
    agent: {
      registerTool: (tool: RegisteredTool) => registeredTools.push(tool),
    } as never,
    ui: { showToast } as never,
  }
  return { ctx: ctx as PluginContext, registeredTools, showToast }
}

async function activate(ctx: PluginContext): Promise<PluginHooks> {
  return (await templatePlugin.activate(ctx)) as PluginHooks
}

describe("cognia-plugin-template-ts", () => {
  it("registers the template_echo tool", async () => {
    const { ctx, registeredTools } = makeCtx()
    await activate(ctx)
    expect(registeredTools).toHaveLength(1)
    expect(registeredTools[0]).toMatchObject({
      name: "template_echo",
      pluginId: "cognia-plugin-template-ts",
    })
  })

  it("returns the supplied message", async () => {
    const { ctx, registeredTools } = makeCtx()
    await activate(ctx)
    await expect(registeredTools[0].execute({ message: "hello" })).resolves.toEqual({
      ok: true,
      echoed: "hello",
    })
  })

  it("coerces a missing message to an empty string", async () => {
    const { ctx, registeredTools } = makeCtx()
    await activate(ctx)
    await expect(registeredTools[0].execute({})).resolves.toEqual({ ok: true, echoed: "" })
  })

  it("handles its declared command through hooks.onCommand", async () => {
    const { ctx, showToast } = makeCtx()
    const hooks = await activate(ctx)
    await expect(hooks.onCommand?.("template-greet", ["Alice"])).resolves.toBe(true)
    expect(showToast).toHaveBeenCalledWith("Hello, Alice!", "success")
  })

  it("uses the default command subject and ignores other commands", async () => {
    const { ctx, showToast } = makeCtx()
    const hooks = await activate(ctx)
    await expect(hooks.onCommand?.("template-greet", [])).resolves.toBe(true)
    expect(showToast).toHaveBeenCalledWith("Hello, world!", "success")
    showToast.mockClear()
    await expect(hooks.onCommand?.("other-command", [])).resolves.toBe(false)
    expect(showToast).not.toHaveBeenCalled()
  })

  it("logs on deactivate", async () => {
    const { ctx } = makeCtx()
    await templatePlugin.deactivate?.(ctx)
    expect(ctx.logger.info).toHaveBeenCalledWith("template-ts plugin deactivated")
  })
})
