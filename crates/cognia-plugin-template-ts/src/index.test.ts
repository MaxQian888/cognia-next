/** @jest-environment jsdom */

import type { FullPluginContext, PluginContext, PluginHooks } from "@cognia/plugin-sdk"
import templatePlugin from "./index"

interface RegisteredTool {
  name: string
  pluginId: string
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

interface RegisteredExtension {
  point: string
  component: unknown
}

const noopDispose = () => {}

function makeCtx() {
  const registeredTools: RegisteredTool[] = []
  const registeredExtensions: RegisteredExtension[] = []
  const showToast = jest.fn()
  const registerTranslations = jest.fn()
  // `FullPluginContext`, not `PluginContext` — `extensions` and `theme` live on
  // the full context the host actually passes to `activate`.
  const ctx: Partial<FullPluginContext> = {
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
    extensions: {
      registerExtension: (point: string, component: unknown) => {
        registeredExtensions.push({ point, component })
        return noopDispose
      },
    } as never,
    // The panel reads motion preferences off here before animating.
    theme: {
      getTheme: () => ({ motion: { reduced: false, durationScale: 1 } }),
    } as never,
    i18n: {
      registerTranslations,
      getCurrentLocale: () => "en",
      onLocaleChange: () => noopDispose,
      t: (key: string) => key,
    } as never,
    ui: { showToast } as never,
  }
  return {
    ctx: ctx as PluginContext,
    registeredTools,
    registeredExtensions,
    registerTranslations,
    showToast,
  }
}

async function activate(ctx: PluginContext): Promise<PluginHooks> {
  return (await templatePlugin.activate(ctx)) as PluginHooks
}

describe("cognia-plugin-template-ts", () => {
  it("mounts its panel into a host UI slot", async () => {
    const { ctx, registeredExtensions } = makeCtx()
    await activate(ctx)
    expect(registeredExtensions).toHaveLength(1)
    expect(registeredExtensions[0].point).toBe("chat.input.actions")
    expect(typeof registeredExtensions[0].component).toBe("function")
  })

  it("registers both supported locale bundles before mounting UI", async () => {
    const { ctx, registerTranslations } = makeCtx()
    await activate(ctx)
    expect(registerTranslations).toHaveBeenCalledWith(
      "en",
      expect.objectContaining({ "panel.clicked": "Clicked {count}" })
    )
    expect(registerTranslations).toHaveBeenCalledWith(
      "zh-CN",
      expect.objectContaining({ "panel.clicked": "已点击 {count} 次" })
    )
  })

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
