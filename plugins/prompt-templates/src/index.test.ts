/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/slash-commands/registry", () => ({
  registerSlashCommand: jest.fn(),
  unregisterCommandsByPlugin: jest.fn(),
}))

import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import promptTemplatesPlugin from "./index"

const registerMock = registerSlashCommand as jest.Mock
const unregisterMock = unregisterCommandsByPlugin as jest.Mock

function makeCtx() {
  const store = new Map<string, unknown>()
  const storage = {
    get: <T>(k: string) => Promise.resolve(store.get(k) as T | undefined),
    set: async (k: string, v: unknown) => {
      store.set(k, v)
    },
    remove: async (k: string) => {
      store.delete(k)
    },
    delete: async (k: string) => {
      store.delete(k)
    },
    has: async (k: string) => store.has(k),
    keys: async () => Array.from(store.keys()),
    clear: async () => store.clear(),
    getOrDefault: async <T>(k: string, d: T) => (store.get(k) as T) ?? d,
    getUsage: async () => 0,
    setSecure: async () => {},
    getSecure: async () => undefined,
    isEncrypted: async () => false,
  }
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-prompt-templates",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    storage: storage as never,
  }
  return { ctx: ctx as PluginContext, store }
}

beforeEach(() => {
  registerMock.mockReset()
  unregisterMock.mockReset()
})

describe("prompt-templates (built-in)", () => {
  it("registers four slash commands", async () => {
    const { ctx } = makeCtx()
    await promptTemplatesPlugin.activate?.(ctx)
    const ids = registerMock.mock.calls.map((c) => c[0].id).sort()
    expect(ids).toEqual(["template", "template-add", "template-list", "template-remove"])
  })

  it("template-add then template returns the stored body", async () => {
    const { ctx } = makeCtx()
    await promptTemplatesPlugin.activate?.(ctx)
    const adder = registerMock.mock.calls.find((c) => c[0].id === "template-add")?.[0]
    const reader = registerMock.mock.calls.find((c) => c[0].id === "template")?.[0]
    expect(adder).toBeDefined()
    expect(reader).toBeDefined()
    const addResult = await adder.handler("greeting Hello, {{name}}!")
    expect(addResult.message).toContain("greeting")
    const readResult = await reader.handler("greeting")
    expect(readResult.message).toContain("Hello, {{name}}!")
  })

  it("template-list returns the saved names", async () => {
    const { ctx } = makeCtx()
    await promptTemplatesPlugin.activate?.(ctx)
    const adder = registerMock.mock.calls.find((c) => c[0].id === "template-add")?.[0]
    const list = registerMock.mock.calls.find((c) => c[0].id === "template-list")?.[0]
    await adder.handler("a body-a")
    await adder.handler("b body-b")
    const out = await list.handler("")
    expect(out.message).toContain("a")
    expect(out.message).toContain("b")
  })

  it("template-remove deletes the entry", async () => {
    const { ctx } = makeCtx()
    await promptTemplatesPlugin.activate?.(ctx)
    const adder = registerMock.mock.calls.find((c) => c[0].id === "template-add")?.[0]
    const reader = registerMock.mock.calls.find((c) => c[0].id === "template")?.[0]
    const remover = registerMock.mock.calls.find((c) => c[0].id === "template-remove")?.[0]
    await adder.handler("foo bar")
    await remover.handler("foo")
    const result = await reader.handler("foo")
    expect(result.message).toContain("not found")
  })

  it("deactivate calls unregisterCommandsByPlugin", async () => {
    const { ctx } = makeCtx()
    await promptTemplatesPlugin.deactivate?.(ctx)
    expect(unregisterMock).toHaveBeenCalledWith("cognia-prompt-templates")
  })
})
