import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/slash-commands/registry", () => ({
  registerSlashCommand: jest.fn(),
  unregisterCommandsByPlugin: jest.fn(),
}))

import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import stagehandMcp from "./index"

const registerMock = registerSlashCommand as jest.Mock
const unregisterMock = unregisterCommandsByPlugin as jest.Mock

function makeCtx() {
  const presets: Array<{ id: string }> = []
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-stagehand-mcp",
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

describe("stagehand-mcp (built-in)", () => {
  it("activate registers the stagehand MCP preset imperatively", async () => {
    const { ctx, presets } = makeCtx()
    await stagehandMcp.activate?.(ctx)
    expect(presets).toEqual([expect.objectContaining({ id: "stagehand", transport: "stdio" })])
  })

  it("marks the Browserbase / OpenAI key fields as env-placed secrets", () => {
    const manifest = stagehandMcp.manifest as unknown as {
      mcpServerPresets: Array<{
        id: string
        fields: Array<{ key: string; placement: string; secret?: boolean }>
      }>
    }
    const preset = manifest.mcpServerPresets[0]
    expect(preset.id).toBe("stagehand")
    const byKey = Object.fromEntries(preset.fields.map((f) => [f.key, f]))
    expect(byKey.BROWSERBASE_API_KEY).toMatchObject({ placement: "env", secret: true })
    expect(byKey.OPENAI_API_KEY).toMatchObject({ placement: "env", secret: true })
    expect(byKey.BROWSERBASE_PROJECT_ID).toMatchObject({ placement: "env" })
  })

  it("activate registers the /stagehand slash command", async () => {
    const { ctx } = makeCtx()
    await stagehandMcp.activate?.(ctx)
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "stagehand.attach",
        name: "/stagehand",
        source: "plugin",
        pluginId: "cognia-stagehand-mcp",
      })
    )
  })

  it("deactivate unregisters the plugin's commands", async () => {
    const { ctx } = makeCtx()
    await stagehandMcp.activate?.(ctx)
    await stagehandMcp.deactivate?.(ctx)
    expect(unregisterMock).toHaveBeenCalledWith("cognia-stagehand-mcp")
  })

  it("deactivate without a context is a safe no-op", async () => {
    await expect(stagehandMcp.deactivate?.(undefined as never)).resolves.toBeUndefined()
    expect(unregisterMock).not.toHaveBeenCalled()
  })
})
