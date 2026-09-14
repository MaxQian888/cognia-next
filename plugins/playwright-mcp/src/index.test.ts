import type { PluginContext } from "@cognia/plugin-sdk"

import playwrightMcp from "./index"
import { getPluginShell, setPluginShell } from "./runtime"
import manifestJson from "../plugin.json"

function makeCtx(overrides: Partial<PluginContext> = {}) {
  const presets: Array<{ id: string }> = []
  const disposers: Array<() => void> = []
  const openModal = jest.fn()
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-playwright-mcp",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    agent: {
      registerMcpServerPreset: (preset: { id: string }) => {
        presets.push(preset)
      },
    } as never,
    shell: { execute: jest.fn() } as never,
    modal: { openModal } as never,
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (dispose: () => void) => disposers.push(dispose),
    } as never,
    ...overrides,
  }
  return { ctx: ctx as PluginContext, presets, openModal, disposers }
}

describe("playwright-mcp (built-in)", () => {
  afterEach(() => {
    // The shell slot is module-global — never leak it across tests.
    setPluginShell(undefined)
  })

  it("activate registers the isolated and CDP presets imperatively", async () => {
    const { ctx, presets } = makeCtx()
    await playwrightMcp.activate?.(ctx)
    expect(presets).toEqual([
      expect.objectContaining({
        id: "playwright-isolated",
        transport: "stdio",
        config: {
          command: "npx",
          args: ["-y", "@playwright/mcp@latest", "--isolated", "--headless"],
        },
        runtime: "both",
      }),
      expect.objectContaining({
        id: "playwright-cdp",
        transport: "stdio",
        config: {
          command: "npx",
          args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint", "<CDP_ENDPOINT>"],
        },
        fields: [
          expect.objectContaining({
            key: "CDP_ENDPOINT",
            placement: "arg-replace",
            token: "<CDP_ENDPOINT>",
          }),
        ],
        runtime: "both",
      }),
    ])
  })

  it("contributes NO preset that collides with the static catalog", () => {
    // `lib/claude/mcp-presets.ts` already owns `playwright` and
    // `playwright-existing-browser`, and `listMcpPresetCatalog` gives static
    // ids precedence — a dynamic entry under either id would be dead weight.
    const manifest = playwrightMcp.manifest as unknown as {
      mcpServerPresets: Array<{ id: string }>
    }
    const ids = manifest.mcpServerPresets.map((p) => p.id)
    expect(ids).toEqual(["playwright-isolated", "playwright-cdp"])
    expect(ids).not.toContain("playwright")
    expect(ids).not.toContain("playwright-existing-browser")
  })

  it("merges plugin.json, the presets, and the i18n bundle into the manifest", () => {
    const manifest = playwrightMcp.manifest as unknown as {
      id: string
      commands: Array<{ id: string }>
      permissions: string[]
      shellCommands: string[]
      mcpServerPresets: Array<{ id: string }>
      i18n: { locales: Record<string, Record<string, string>> }
    }
    expect(manifest.id).toBe("cognia-playwright-mcp")
    // plugin.json fields must survive the module-over-JSON merge — a
    // hand-written subset would silently drop them.
    expect(manifest.commands.map((c) => c.id)).toEqual(["browser"])
    expect(manifest.permissions).toEqual(expect.arrayContaining(["extension:ui", "shell:execute"]))
    expect(manifest.shellCommands).toEqual(["node", "npx"])
    expect(Object.keys(manifest.i18n.locales).sort()).toEqual(["en", "zh-CN"])
  })

  it("publishes ctx.shell for the modal's environment check and clears it on dispose", async () => {
    const { ctx, disposers } = makeCtx()
    await playwrightMcp.activate?.(ctx)
    expect(getPluginShell()).toBe(ctx.shell)
    expect(disposers).toHaveLength(1)
    disposers[0]()
    expect(getPluginShell()).toBeUndefined()
  })

  it("has no deactivate — lifecycle.onDispose owns per-generation cleanup", () => {
    // The shell slot is cleared through the generation lifecycle ledger and
    // manifest-declared commands are unregistered by
    // `PluginManager.unregisterPluginSlashCommands`, so there is nothing a
    // plugin-level deactivate would still need to undo.
    expect(playwrightMcp.deactivate).toBeUndefined()
  })

  it("declares its slash command and lazy activation in plugin.json", async () => {
    const { ctx } = makeCtx()
    const hooks = await playwrightMcp.activate?.(ctx)
    expect(typeof hooks?.onCommand).toBe("function")
    expect(manifestJson.commands?.map((c) => c.id)).toEqual(["browser"])
    expect(manifestJson.activationEvents).toContain("onCommand:browser")
  })

  it("handles /browser by opening the setup modal, and declines other commands", async () => {
    const { ctx, openModal } = makeCtx()
    const hooks = await playwrightMcp.activate?.(ctx)

    expect(await hooks?.onCommand?.("not-mine", [])).toBe(false)
    expect(openModal).not.toHaveBeenCalled()

    const result = await hooks?.onCommand?.("browser", [])
    expect(openModal).toHaveBeenCalledTimes(1)
    expect(openModal.mock.calls[0][2]).toEqual({ size: "lg" })
    expect(result).toEqual({ handled: true, message: expect.any(String) })
  })

  it("returns a localized fallback message when the host has no modal API", async () => {
    const { ctx, openModal } = makeCtx({ modal: undefined })
    const t = jest.fn((key: string) => `translated:${key}`)
    ;(ctx as { i18n?: unknown }).i18n = { t }
    const hooks = await playwrightMcp.activate?.(ctx)
    const result = await hooks?.onCommand?.("browser", [])
    expect(openModal).not.toHaveBeenCalled()
    expect(result).toEqual({ handled: true, message: "translated:command.noModal" })
  })
})
