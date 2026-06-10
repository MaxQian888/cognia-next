/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

jest.mock("@/lib/slash-commands/registry", () => ({
  registerSlashCommand: jest.fn(),
  unregisterCommandsByPlugin: jest.fn(),
}))

import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import clipboardHistory from "./index"

const registerMock = registerSlashCommand as jest.Mock
const unregisterMock = unregisterCommandsByPlugin as jest.Mock

function makeCtx(config: Record<string, unknown> = {}) {
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {}
  const secureStore = new Map<string, unknown>()
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-clipboard-history",
    config,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      delete: async () => {},
      has: async () => false,
      keys: async () => [],
      clear: async () => {},
      getUsage: async () => 0,
      getOrDefault: async <T>(_k: string, d: T) => d,
      setSecure: async (k: string, v: unknown) => {
        secureStore.set(k, v)
      },
      getSecure: async <T>(k: string) => secureStore.get(k) as T | undefined,
      isEncrypted: async () => false,
    } as never,
    agent: {
      registerTool: ({
        name,
        execute,
      }: {
        name: string
        execute: (args: unknown) => Promise<unknown>
      }) => {
        tools[name] = execute
      },
    } as never,
  }
  return { ctx: ctx as PluginContext, tools, secureStore }
}

beforeEach(() => {
  registerMock.mockReset()
  unregisterMock.mockReset()
})

describe("clipboard-history (built-in)", () => {
  it("registers three tools and one slash command", async () => {
    const { ctx, tools } = makeCtx()
    await clipboardHistory.activate?.(ctx)
    expect(Object.keys(tools).sort()).toEqual([
      "clipboard_history_add",
      "clipboard_history_clear",
      "clipboard_history_list",
    ])
    expect(registerMock).toHaveBeenCalledWith(expect.objectContaining({ id: "clipboard-history" }))
  })

  it("clipboard_history_add stores entries in the secure buffer", async () => {
    const { ctx, tools, secureStore } = makeCtx()
    await clipboardHistory.activate?.(ctx)
    const r1 = (await tools.clipboard_history_add({ text: "alpha" })) as {
      ok: boolean
      added: boolean
    }
    expect(r1.added).toBe(true)
    const r2 = (await tools.clipboard_history_add({ text: "beta" })) as {
      added: boolean
    }
    expect(r2.added).toBe(true)
    expect(Array.isArray(secureStore.get("buffer"))).toBe(true)
    expect((secureStore.get("buffer") as Array<{ text: string }>).length).toBe(2)
  })

  it("does not push duplicate consecutive entries", async () => {
    const { ctx, tools } = makeCtx()
    await clipboardHistory.activate?.(ctx)
    await tools.clipboard_history_add({ text: "alpha" })
    const second = (await tools.clipboard_history_add({ text: "alpha" })) as {
      added: boolean
    }
    expect(second.added).toBe(false)
  })

  it("respects privacyMode by refusing to persist", async () => {
    const { ctx, tools, secureStore } = makeCtx({ privacyMode: true })
    await clipboardHistory.activate?.(ctx)
    const result = (await tools.clipboard_history_add({ text: "alpha" })) as {
      added: boolean
    }
    expect(result.added).toBe(false)
    expect(secureStore.get("buffer")).toBeUndefined()
  })

  it("clear empties the buffer", async () => {
    const { ctx, tools, secureStore } = makeCtx()
    await clipboardHistory.activate?.(ctx)
    await tools.clipboard_history_add({ text: "x" })
    await tools.clipboard_history_clear({})
    expect(secureStore.get("buffer")).toEqual([])
  })

  it("deactivate calls unregisterCommandsByPlugin", async () => {
    const { ctx } = makeCtx()
    await clipboardHistory.activate?.(ctx)
    await clipboardHistory.deactivate?.(ctx)
    expect(unregisterMock).toHaveBeenCalledWith("cognia-clipboard-history")
  })
})
