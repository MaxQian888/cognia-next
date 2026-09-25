import type { PluginContext } from "@cognia/plugin-sdk"

import playwrightMcp, { manifest } from "./index"
import { getSetupModalHost, setSetupModalHost } from "./runtime"
import manifestJson from "../plugin.json"

function makeCtx() {
  const disposers: Array<() => void> = []
  const openModal = jest.fn()
  const navigate = jest.fn(() => true)
  const registerMcpServerPreset = jest.fn()
  const ctx = {
    pluginId: "cognia-playwright-mcp",
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    agent: { registerMcpServerPreset },
    shell: { execute: jest.fn() },
    ui: { navigate },
    modal: { openModal },
    i18n: { t: jest.fn((key: string) => `t:${key}`) },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (dispose: () => void) => disposers.push(dispose),
    },
  } as unknown as PluginContext
  return { ctx, openModal, navigate, disposers, registerMcpServerPreset }
}

describe("playwright-mcp (built-in)", () => {
  afterEach(() => {
    // The host slot is module-global — never leak it across tests.
    setSetupModalHost(undefined)
  })

  it("declares the isolated and CDP presets in plugin.json", () => {
    expect(manifestJson.mcpServerPresets).toEqual([
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

  it("leaves preset registration to the manager instead of registering imperatively", async () => {
    const { ctx, registerMcpServerPreset } = makeCtx()
    await playwrightMcp.activate(ctx)
    expect(registerMcpServerPreset).not.toHaveBeenCalled()
  })

  it("contributes NO preset that collides with the static catalog", () => {
    // `lib/claude/mcp-presets.ts` already owns `playwright` and
    // `playwright-existing-browser`, and `listMcpPresetCatalog` gives static
    // ids precedence — a dynamic entry under either id would be dead weight.
    const ids = (manifest.mcpServerPresets ?? []).map((p) => p.id)
    expect(ids).toEqual(["playwright-isolated", "playwright-cdp"])
    expect(ids).not.toContain("playwright")
    expect(ids).not.toContain("playwright-existing-browser")
  })

  it("is plugin.json, unchanged", () => {
    expect(manifest).toEqual(manifestJson)
    expect(manifest.commands?.map((c) => c.id)).toEqual(["browser"])
    expect(manifest.permissions).toEqual(expect.arrayContaining(["extension:ui", "shell:execute"]))
    expect(manifest.shellCommands).toEqual(["node", "npx"])
    expect(Object.keys(manifestJson.i18n.locales).sort()).toEqual(["en", "zh-CN"])
  })

  it("ships every English key in Chinese too", () => {
    const { en, "zh-CN": zh } = manifestJson.i18n.locales
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it("publishes the shell and in-app navigation for the modal and clears them on dispose", async () => {
    const { ctx, disposers, navigate } = makeCtx()
    await playwrightMcp.activate(ctx)
    const host = getSetupModalHost()
    expect(host?.shell).toBe(ctx.shell)
    expect(host?.navigate("/settings?section=mcp")).toBe(true)
    expect(navigate).toHaveBeenCalledWith("/settings?section=mcp")
    expect(disposers).toHaveLength(1)
    disposers[0]()
    expect(getSetupModalHost()).toBeUndefined()
  })

  it("has no deactivate — lifecycle.onDispose owns per-generation cleanup", () => {
    // The host slot is cleared through the generation lifecycle ledger and
    // manifest-declared commands are unregistered by
    // `PluginManager.unregisterPluginSlashCommands`, so there is nothing a
    // plugin-level deactivate would still need to undo.
    expect(playwrightMcp.deactivate).toBeUndefined()
  })

  it("declares its slash command and lazy activation in plugin.json", async () => {
    const { ctx } = makeCtx()
    const hooks = await playwrightMcp.activate(ctx)
    expect(typeof hooks?.onCommand).toBe("function")
    expect(manifestJson.commands?.map((c) => c.id)).toEqual(["browser"])
    expect(manifestJson.activationEvents).toContain("onCommand:browser")
  })

  it("handles /browser by opening the setup modal, and declines other commands", async () => {
    const { ctx, openModal } = makeCtx()
    const hooks = await playwrightMcp.activate(ctx)

    expect(await hooks?.onCommand?.("not-mine", [])).toBe(false)
    expect(openModal).not.toHaveBeenCalled()

    const result = await hooks?.onCommand?.("browser", [])
    expect(openModal).toHaveBeenCalledTimes(1)
    expect(openModal.mock.calls[0][2]).toEqual({ size: "lg" })
    expect(result).toEqual({ handled: true, message: "t:command.opened" })
  })
})
