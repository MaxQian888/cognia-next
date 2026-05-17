/**
 * @jest-environment jsdom
 *
 * Tests for the template plugin. Mirrors the mock-PluginContext pattern in
 * `plugins/prompt-templates/src/index.test.ts` so the template doubles as a
 * worked example of how to test a real plugin.
 */

import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/chat/slash-command-registry", () => ({
  registerSlashCommand: jest.fn(),
  unregisterCommandsByPlugin: jest.fn(),
}))

import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/chat/slash-command-registry"
import templatePlugin from "./index"

const registerSlashMock = registerSlashCommand as jest.Mock
const unregisterMock = unregisterCommandsByPlugin as jest.Mock

interface RegisteredTool {
  name: string
  pluginId: string
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

function makeCtx() {
  const registeredTools: RegisteredTool[] = []
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
      },
    } as never,
  }
  return { ctx: ctx as PluginContext, registeredTools }
}

beforeEach(() => {
  registerSlashMock.mockReset()
  unregisterMock.mockReset()
})

describe("cognia-plugin-template-ts", () => {
  it("registers the template_echo tool on activate", async () => {
    const { ctx, registeredTools } = makeCtx()
    await templatePlugin.activate?.(ctx)
    expect(registeredTools).toHaveLength(1)
    expect(registeredTools[0].name).toBe("template_echo")
    expect(registeredTools[0].pluginId).toBe("cognia-plugin-template-ts")
  })

  it("registers the template-greet slash command on activate", async () => {
    const { ctx } = makeCtx()
    await templatePlugin.activate?.(ctx)
    const calls = registerSlashMock.mock.calls.map((c) => c[0].id)
    expect(calls).toContain("template-greet")
  })

  it("template_echo returns the supplied message", async () => {
    const { ctx, registeredTools } = makeCtx()
    await templatePlugin.activate?.(ctx)
    const echo = registeredTools.find((t) => t.name === "template_echo")
    expect(echo).toBeDefined()
    const result = (await echo!.execute({ message: "hello world" })) as {
      ok: boolean
      echoed: string
    }
    expect(result).toEqual({ ok: true, echoed: "hello world" })
  })

  it("template_echo coerces a missing message to empty string", async () => {
    const { ctx, registeredTools } = makeCtx()
    await templatePlugin.activate?.(ctx)
    const echo = registeredTools.find((t) => t.name === "template_echo")
    const result = (await echo!.execute({})) as { ok: boolean; echoed: string }
    expect(result).toEqual({ ok: true, echoed: "" })
  })

  it("template-greet handler defaults to 'world'", async () => {
    const { ctx } = makeCtx()
    await templatePlugin.activate?.(ctx)
    const greet = registerSlashMock.mock.calls.find((c) => c[0].id === "template-greet")?.[0]
    expect(greet).toBeDefined()
    const result = await greet.handler("")
    expect(result.message).toBe("Hello, world!")
  })

  it("template-greet handler uses the supplied argument", async () => {
    const { ctx } = makeCtx()
    await templatePlugin.activate?.(ctx)
    const greet = registerSlashMock.mock.calls.find((c) => c[0].id === "template-greet")?.[0]
    const result = await greet.handler("Alice")
    expect(result.message).toBe("Hello, Alice!")
  })

  it("deactivate calls unregisterCommandsByPlugin with the plugin id", async () => {
    const { ctx } = makeCtx()
    await templatePlugin.deactivate?.(ctx)
    expect(unregisterMock).toHaveBeenCalledWith("cognia-plugin-template-ts")
  })

  it("deactivate swallows registry errors", async () => {
    const { ctx } = makeCtx()
    unregisterMock.mockImplementationOnce(() => {
      throw new Error("registry gone")
    })
    await expect(templatePlugin.deactivate?.(ctx)).resolves.toBeUndefined()
  })
})
