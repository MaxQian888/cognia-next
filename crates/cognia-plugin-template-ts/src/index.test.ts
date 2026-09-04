/** @jest-environment jsdom */

import type { PluginContext, PluginHooks } from "@cognia/plugin-sdk"
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

interface RegisteredNode {
  kind: string
  execute: (step: Record<string, unknown>) => Promise<unknown>
}

interface RegisteredTrigger {
  kind: string
  start: (trigger: Record<string, unknown>) => Promise<{ stop: () => void }>
}

const noopDispose = () => {}

function makeCtx(settings: Record<string, unknown> = {}) {
  const registeredTools: RegisteredTool[] = []
  const registeredExtensions: RegisteredExtension[] = []
  const registeredNodes: RegisteredNode[] = []
  const registeredTriggers: RegisteredTrigger[] = []
  const disposeLabels: string[] = []
  const store = new Map<string, unknown>()
  const showToast = jest.fn()
  const registerTranslations = jest.fn()
  const settingsChangeHandlers = new Map<string, (value: unknown) => void>()

  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-plugin-template-ts",
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as never,
    agent: {
      registerTool: (tool: RegisteredTool) => {
        registeredTools.push(tool)
        return noopDispose
      },
    } as never,
    extensions: {
      registerExtension: (point: string, component: unknown) => {
        registeredExtensions.push({ point, component })
        return noopDispose
      },
    } as never,
    workflow: {
      registerNode: (node: RegisteredNode) => {
        registeredNodes.push(node)
        return noopDispose
      },
      registerTrigger: (trigger: RegisteredTrigger) => {
        registeredTriggers.push(trigger)
        return noopDispose
      },
    } as never,
    // Every registration above is handed to the lifecycle ledger, so the labels
    // are the assertion that nothing was registered without a way back off.
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (_dispose: () => void, label?: string) => {
        disposeLabels.push(label ?? "")
      },
    } as never,
    settings: {
      get: (key: string) => settings[key],
      set: (key: string, value: unknown) => {
        settings[key] = value
      },
      onChange: (key: string, handler: (value: unknown) => void) => {
        settingsChangeHandlers.set(key, handler)
        return noopDispose
      },
    } as never,
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, value)
      },
      delete: async (key: string) => {
        store.delete(key)
      },
      keys: async () => [...store.keys()],
      clear: async () => store.clear(),
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
    registeredNodes,
    registeredTriggers,
    disposeLabels,
    registerTranslations,
    settingsChangeHandlers,
    showToast,
    store,
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

  it("hands every registration to the lifecycle ledger", async () => {
    const { ctx, disposeLabels } = makeCtx()
    await activate(ctx)
    expect(disposeLabels).toEqual([
      "settings:greetingPrefix",
      "extension:chat.input.actions",
      "tool:template_echo",
      "workflow:node:action.echo",
      "workflow:trigger:trigger.ticker",
    ])
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

  it("returns the supplied message and counts the call in storage", async () => {
    const { ctx, registeredTools, store } = makeCtx()
    await activate(ctx)
    await expect(registeredTools[0].execute({ message: "hello" })).resolves.toEqual({
      ok: true,
      echoed: "hello",
      calls: 1,
    })
    await expect(registeredTools[0].execute({ message: "again" })).resolves.toEqual({
      ok: true,
      echoed: "again",
      calls: 2,
    })
    expect(store.get("echoCount")).toBe(2)
  })

  it("applies the shoutEcho setting to the tool result", async () => {
    const { ctx, registeredTools } = makeCtx({ shoutEcho: true })
    await activate(ctx)
    await expect(registeredTools[0].execute({ message: "hello" })).resolves.toMatchObject({
      echoed: "HELLO",
    })
  })

  it("coerces a missing message to an empty string", async () => {
    const { ctx, registeredTools } = makeCtx()
    await activate(ctx)
    await expect(registeredTools[0].execute({})).resolves.toEqual({
      ok: true,
      echoed: "",
      calls: 1,
    })
  })

  it("contributes a workflow node that passes its param downstream", async () => {
    const { ctx, registeredNodes } = makeCtx()
    await activate(ctx)
    expect(registeredNodes.map((node) => node.kind)).toEqual(["action.echo"])
    await expect(
      registeredNodes[0].execute({ params: { message: "onward" }, log: jest.fn() })
    ).resolves.toEqual({ output: { message: "onward" } })
  })

  it("contributes a trigger whose stop clears the interval and honours abort", async () => {
    jest.useFakeTimers()
    try {
      const { ctx, registeredTriggers } = makeCtx()
      await activate(ctx)
      expect(registeredTriggers.map((trigger) => trigger.kind)).toEqual(["trigger.ticker"])

      const emit = jest.fn()
      const controller = new AbortController()
      const handle = await registeredTriggers[0].start({
        workflowId: "wf_1",
        params: { intervalMs: 1000 },
        emit,
        signal: controller.signal,
      })

      jest.advanceTimersByTime(2000)
      expect(emit).toHaveBeenCalledTimes(2)

      // Teardown goes through the signal, not only through `stop()`, because
      // the host aborts the generation before it drains the ledger.
      controller.abort()
      jest.advanceTimersByTime(5000)
      expect(emit).toHaveBeenCalledTimes(2)
      handle.stop()
    } finally {
      jest.useRealTimers()
    }
  })

  it("answers its declared command with a markdown result", async () => {
    const { ctx, showToast } = makeCtx()
    const hooks = await activate(ctx)
    await expect(hooks.onCommand?.("template-greet", ["Alice"])).resolves.toEqual({
      handled: true,
      message: "Hello, Alice!",
    })
    expect(showToast).toHaveBeenCalledWith("Hello, Alice!", "success")
  })

  it("takes the greeting prefix from settings", async () => {
    const { ctx } = makeCtx({ greetingPrefix: "Bonjour" })
    const hooks = await activate(ctx)
    await expect(hooks.onCommand?.("template-greet", ["Alice"])).resolves.toMatchObject({
      message: "Bonjour, Alice!",
    })
  })

  it("uses the default command subject and declines other commands", async () => {
    const { ctx, showToast } = makeCtx()
    const hooks = await activate(ctx)
    await expect(hooks.onCommand?.("template-greet", [])).resolves.toMatchObject({
      message: "Hello, world!",
    })
    showToast.mockClear()
    await expect(hooks.onCommand?.("other-command", [])).resolves.toBe(false)
    expect(showToast).not.toHaveBeenCalled()
  })

  it("subscribes to its own setting and logs config pushes", async () => {
    const { ctx, settingsChangeHandlers } = makeCtx()
    const hooks = await activate(ctx)
    expect(settingsChangeHandlers.has("greetingPrefix")).toBe(true)
    settingsChangeHandlers.get("greetingPrefix")?.("Hi")
    hooks.onConfigChange?.({ greetingPrefix: "Hi" })
    expect(ctx.logger.debug).toHaveBeenCalledWith("template-ts config changed", {
      keys: ["greetingPrefix"],
    })
  })

  it("logs on deactivate", async () => {
    const { ctx } = makeCtx()
    await templatePlugin.deactivate?.(ctx)
    expect(ctx.logger.info).toHaveBeenCalledWith("template-ts plugin deactivated")
  })
})
