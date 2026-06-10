import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/slash-commands/registry", () => ({
  registerSlashCommand: jest.fn(),
  unregisterCommandsByPlugin: jest.fn(),
}))

import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import playwrightMcp from "./index"

const registerMock = registerSlashCommand as jest.Mock
const unregisterMock = unregisterCommandsByPlugin as jest.Mock

function makeCtx() {
  const presets: Array<{ id: string }> = []
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-playwright-mcp",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    agent: {
      registerMcpServerPreset: (preset: { id: string }) => {
        presets.push(preset)
      },
    } as never,
  }
  return { ctx: ctx as PluginContext, presets }
}

beforeEach(() => {
  registerMock.mockReset()
  unregisterMock.mockReset()
})

describe("playwright-mcp (built-in)", () => {
  it("activate registers the playwright MCP preset imperatively", async () => {
    const { ctx, presets } = makeCtx()
    await playwrightMcp.activate?.(ctx)
    expect(presets).toEqual([
      expect.objectContaining({
        id: "playwright",
        transport: "stdio",
        config: expect.objectContaining({ command: "npx" }),
      }),
    ])
  })

  it("declares the same preset on the manifest for the declarative walker", () => {
    const manifest = playwrightMcp.manifest as unknown as {
      mcpServerPresets: Array<{ id: string }>
    }
    expect(manifest.mcpServerPresets.map((p) => p.id)).toEqual(["playwright"])
  })

  it("activate registers the /browser slash command", async () => {
    const { ctx } = makeCtx()
    await playwrightMcp.activate?.(ctx)
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "playwright.attach",
        name: "/browser",
        source: "plugin",
        pluginId: "cognia-playwright-mcp",
      })
    )
  })

  it("deactivate unregisters the plugin's commands", async () => {
    const { ctx } = makeCtx()
    await playwrightMcp.activate?.(ctx)
    await playwrightMcp.deactivate?.(ctx)
    expect(unregisterMock).toHaveBeenCalledWith("cognia-playwright-mcp")
  })

  it("deactivate without a context is a safe no-op", async () => {
    await expect(playwrightMcp.deactivate?.(undefined as never)).resolves.toBeUndefined()
    expect(unregisterMock).not.toHaveBeenCalled()
  })
})
