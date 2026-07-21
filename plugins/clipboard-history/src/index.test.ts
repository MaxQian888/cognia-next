/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

jest.mock("@/lib/slash-commands/registry", () => ({
  registerSlashCommand: jest.fn(),
  unregisterCommandsByPlugin: jest.fn(),
}))

// Virtual double for the desktop clipboard read path.
const mockTauriReadText = jest.fn(async () => "")
jest.mock(
  "@tauri-apps/plugin-clipboard-manager",
  () => ({
    readText: (...a: unknown[]) => (mockTauriReadText as (...x: unknown[]) => unknown)(...a),
  }),
  { virtual: true }
)

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
    expect(registerMock).not.toHaveBeenCalled()
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

  it("leaves command teardown to the manager", async () => {
    const { ctx } = makeCtx()
    await clipboardHistory.activate?.(ctx)
    await clipboardHistory.deactivate?.(ctx)
    expect(unregisterMock).not.toHaveBeenCalled()
  })

  it("the declared command reports empty and formatted buffers", async () => {
    const { ctx } = makeCtx()
    const showToast = jest.fn()
    ;(ctx as { ui?: unknown }).ui = { showToast }
    const hooks = (await clipboardHistory.activate?.(ctx)) as unknown as {
      onCommand?: (c: string, a: string[]) => Promise<boolean>
    }
    expect(await hooks?.onCommand?.("not-mine", [])).toBe(false)
    expect(await hooks?.onCommand?.("clipboard-history", [])).toBe(true)
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/empty/i), "info")
  })

  it("a successful Tauri poll persists the captured clipboard text", async () => {
    jest.useFakeTimers()
    mockTauriReadText.mockResolvedValue("desktop copied text")
    const { ctx, secureStore } = makeCtx({ pollIntervalMs: 10, privacyMode: false })
    ;(ctx as { capabilities?: { tauri: boolean } }).capabilities = { tauri: true }
    try {
      await clipboardHistory.activate?.(ctx)
      await jest.advanceTimersByTimeAsync(10)
      const buffer = secureStore.get("buffer") as Array<{ text: string }> | undefined
      expect(buffer?.some((e) => e.text === "desktop copied text")).toBe(true)
    } finally {
      await clipboardHistory.deactivate?.(ctx)
      jest.useRealTimers()
    }
  })

  it("logs (does not crash) when a background poll cycle fails", async () => {
    jest.useFakeTimers()
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: async () => "captured text" },
      configurable: true,
    })
    const warn = jest.fn()
    const { ctx } = makeCtx({ pollIntervalMs: 10, privacyMode: false })
    ctx.logger = { info: jest.fn(), warn, error: jest.fn() } as never
    // Force the persist step to reject so the detached interval body hits the
    // guard instead of producing an unhandled rejection.
    ;(ctx.storage as { setSecure: (k: string, v: unknown) => Promise<void> }).setSecure =
      async () => {
        throw new Error("secure store unavailable")
      }
    try {
      await clipboardHistory.activate?.(ctx)
      await jest.advanceTimersByTimeAsync(10)
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/poll failed: secure store unavailable/)
      )
    } finally {
      await clipboardHistory.deactivate?.(ctx)
      jest.useRealTimers()
    }
  })
})
