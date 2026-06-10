/**
 * @jest-environment jsdom
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"

const isTauriMock = jest.fn(() => false)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const readTextMock = jest.fn<Promise<string>, []>()
jest.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: () => readTextMock() }), {
  virtual: true,
})

type ToolResult = { ok: boolean; content?: string; error?: string }

function makeCtx(capabilities?: { tauri?: boolean }) {
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {}
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-clipboard-tools",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    capabilities: capabilities as never,
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
  return { ctx: ctx as PluginContext, tools }
}

/** Fresh module instance per test — the plugin caches a module-scoped flag. */
async function loadPlugin(): Promise<PluginDefinition> {
  let definition: PluginDefinition | undefined
  await jest.isolateModulesAsync(async () => {
    definition = (await import("./index")).default
  })
  return definition!
}

function setNavigatorClipboard(readText: (() => Promise<string>) | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    value: readText ? { readText } : undefined,
    configurable: true,
  })
}

beforeEach(() => {
  isTauriMock.mockReset().mockReturnValue(false)
  readTextMock.mockReset()
  setNavigatorClipboard(undefined)
})

describe("clipboard-tools (built-in)", () => {
  it("activate registers the clipboard_status tool", async () => {
    const plugin = await loadPlugin()
    const { ctx, tools } = makeCtx({ tauri: false })
    await plugin.activate?.(ctx)
    expect(Object.keys(tools)).toEqual(["clipboard_status"])
  })

  it("reads via the browser Clipboard API when ctx.capabilities.tauri is false", async () => {
    const plugin = await loadPlugin()
    const { ctx, tools } = makeCtx({ tauri: false })
    setNavigatorClipboard(async () => "browser text")
    await plugin.activate?.(ctx)
    const result = (await tools.clipboard_status({})) as ToolResult
    expect(result).toEqual({ ok: true, content: "browser text" })
  })

  it("prefers ctx.capabilities.tauri over the direct isTauri() probe", async () => {
    const plugin = await loadPlugin()
    const { ctx, tools } = makeCtx({ tauri: true })
    // The direct probe says "browser" — the host capability must win.
    isTauriMock.mockReturnValue(false)
    readTextMock.mockResolvedValue("os clipboard")
    await plugin.activate?.(ctx)
    const result = (await tools.clipboard_status({})) as ToolResult
    expect(result).toEqual({ ok: true, content: "os clipboard" })
    expect(isTauriMock).not.toHaveBeenCalled()
  })

  it("falls back to isTauri() when the host exposes no capabilities", async () => {
    const plugin = await loadPlugin()
    const { ctx, tools } = makeCtx(undefined)
    isTauriMock.mockReturnValue(true)
    readTextMock.mockResolvedValue("fallback os clipboard")
    await plugin.activate?.(ctx)
    const result = (await tools.clipboard_status({})) as ToolResult
    expect(result).toEqual({ ok: true, content: "fallback os clipboard" })
    expect(isTauriMock).toHaveBeenCalled()
  })

  it("returns ok:false when no clipboard backend is available", async () => {
    const plugin = await loadPlugin()
    const { ctx, tools } = makeCtx({ tauri: false })
    await plugin.activate?.(ctx)
    const result = (await tools.clipboard_status({})) as ToolResult
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not available/i)
  })

  it("deactivate is a no-op (runtime unregisters tools by pluginId)", async () => {
    const plugin = await loadPlugin()
    const { ctx } = makeCtx({ tauri: false })
    await plugin.activate?.(ctx)
    await expect(plugin.deactivate?.(ctx)).resolves.toBeUndefined()
  })
})
