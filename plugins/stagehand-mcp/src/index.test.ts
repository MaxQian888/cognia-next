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

  it("points at the package that actually exists on npm", () => {
    // `@browserbasehq/mcp-stagehand` is a hard 404 and
    // `@browserbasehq/mcp-server-browserbase` is deprecated — either one makes
    // `npx` fail at spawn on every launch.
    const manifest = stagehandMcp.manifest as unknown as {
      mcpServerPresets: Array<{ config: { command: string; args: string[] } }>
    }
    const { command, args } = manifest.mcpServerPresets[0].config
    expect(command).toBe("npx")
    expect(args.join(" ")).toContain("@browserbasehq/mcp@")
    expect(args.join(" ")).not.toContain("mcp-stagehand")
    expect(args.join(" ")).not.toContain("mcp-server-browserbase")
  })

  it("marks the Browserbase / model key fields as env-placed secrets", () => {
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
    // v3 defaults to google/gemini-2.5-flash-lite, not GPT-4o.
    expect(byKey.GEMINI_API_KEY).toMatchObject({ placement: "env", secret: true })
    expect(byKey.OPENAI_API_KEY).toBeUndefined()
    expect(byKey.BROWSERBASE_PROJECT_ID).toMatchObject({ placement: "env" })
  })

  it("has no deactivate — the manager owns command teardown", () => {
    // The plugin registers nothing imperatively any more, so there is nothing
    // for it to undo. Manifest-declared commands are unregistered by
    // `PluginManager.unregisterPluginSlashCommands`.
    expect(stagehandMcp.deactivate).toBeUndefined()
    expect(unregisterMock).not.toHaveBeenCalled()
  })

  it("declares its slash command instead of registering it imperatively", async () => {
    const { ctx } = makeCtx()
    const hooks = await stagehandMcp.activate?.(ctx)
    // The manager owns registration for manifest-declared commands; a plugin
    // touching the registry itself skips namespacing, conflict detection,
    // aliases, the command-palette entry and teardown.
    expect(registerMock).not.toHaveBeenCalled()
    expect(typeof hooks?.onCommand).toBe("function")
    const commands = (stagehandMcp.manifest as { commands?: Array<{ id: string }> }).commands
    expect(commands?.map((c) => c.id)).toEqual(["stagehand"])
  })

  it("handles its own command and declines others", async () => {
    const { ctx } = makeCtx()
    const showToast = jest.fn()
    ;(ctx as { ui?: unknown }).ui = { showToast }
    const hooks = await stagehandMcp.activate?.(ctx)
    expect(await hooks?.onCommand?.("not-mine", [])).toBe(false)
    expect(showToast).not.toHaveBeenCalled()
    expect(await hooks?.onCommand?.("stagehand", [])).toBe(true)
    expect(showToast).toHaveBeenCalled()
  })

  it("declares lazy activation for its command", () => {
    const events = (stagehandMcp.manifest as { activationEvents?: string[] }).activationEvents
    expect(events).toContain("onCommand:stagehand")
  })
})
