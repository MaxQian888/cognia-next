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
  it("activate registers isolated and existing-browser presets imperatively", async () => {
    const { ctx, presets } = makeCtx()
    await playwrightMcp.activate?.(ctx)
    expect(presets).toEqual([
      expect.objectContaining({
        id: "playwright",
        transport: "stdio",
        config: expect.objectContaining({ command: "npx" }),
      }),
      expect.objectContaining({
        id: "playwright-existing-browser",
        transport: "stdio",
        config: {
          command: "npx",
          args: ["-y", "@playwright/mcp@latest", "--extension"],
        },
        defaultDisallowedTools: ["browser_run_code_unsafe"],
      }),
    ])
  })

  it("declares the same preset on the manifest for the declarative walker", () => {
    const manifest = playwrightMcp.manifest as unknown as {
      mcpServerPresets: Array<{ id: string }>
    }
    expect(manifest.mcpServerPresets.map((p) => p.id)).toEqual([
      "playwright",
      "playwright-existing-browser",
    ])
  })

  it("has no deactivate — the manager owns command teardown", () => {
    // The plugin registers nothing imperatively any more, so there is nothing
    // for it to undo. Manifest-declared commands are unregistered by
    // `PluginManager.unregisterPluginSlashCommands`.
    expect(playwrightMcp.deactivate).toBeUndefined()
    expect(unregisterMock).not.toHaveBeenCalled()
  })

  it("declares its slash command instead of registering it imperatively", async () => {
    const { ctx } = makeCtx()
    const hooks = await playwrightMcp.activate?.(ctx)
    // The manager owns registration for manifest-declared commands; a plugin
    // touching the registry itself skips namespacing, conflict detection,
    // aliases, the command-palette entry and teardown.
    expect(registerMock).not.toHaveBeenCalled()
    expect(typeof hooks?.onCommand).toBe("function")
    const commands = (playwrightMcp.manifest as { commands?: Array<{ id: string }> }).commands
    expect(commands?.map((c) => c.id)).toEqual(["browser"])
  })

  it("handles its own command and declines others", async () => {
    const { ctx } = makeCtx()
    const showToast = jest.fn()
    ;(ctx as { ui?: unknown }).ui = { showToast }
    const hooks = await playwrightMcp.activate?.(ctx)
    expect(await hooks?.onCommand?.("not-mine", [])).toBe(false)
    expect(showToast).not.toHaveBeenCalled()
    expect(await hooks?.onCommand?.("browser", [])).toBe(true)
    expect(showToast).toHaveBeenCalled()
  })

  it("declares lazy activation for its command", () => {
    const events = (playwrightMcp.manifest as { activationEvents?: string[] }).activationEvents
    expect(events).toContain("onCommand:browser")
  })
})
