import type { PluginContext } from "@cognia/plugin-sdk"

import stagehandMcp, { manifest } from "./index"
import { getSetupModalHost, setSetupModalHost } from "./runtime"
import manifestJson from "../plugin.json"

function makeCtx() {
  const disposers: Array<() => void> = []
  const openModal = jest.fn()
  const navigate = jest.fn(() => true)
  const registerMcpServerPreset = jest.fn()
  const ctx = {
    pluginId: "cognia-stagehand-mcp",
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

type PresetJson = (typeof manifestJson.mcpServerPresets)[number]
const preset = (id: string): PresetJson | undefined =>
  manifestJson.mcpServerPresets.find((entry) => entry.id === id)

describe("stagehand-mcp (built-in)", () => {
  afterEach(() => {
    // The host slot is module-global — never leak it across tests.
    setSetupModalHost(undefined)
  })

  it("declares the hosted and self-hosted presets in plugin.json", () => {
    expect(manifestJson.mcpServerPresets).toEqual([
      expect.objectContaining({
        id: "stagehand-hosted",
        transport: "http",
        config: { url: "https://mcp.browserbase.com/mcp", headers: {} },
        runtime: "both",
      }),
      expect.objectContaining({
        id: "stagehand",
        transport: "stdio",
        config: {
          command: "npx",
          args: ["-y", "@browserbasehq/mcp@latest"],
          env: { BROWSERBASE_API_KEY: "", BROWSERBASE_PROJECT_ID: "", GEMINI_API_KEY: "" },
        },
        runtime: "both",
      }),
    ])
  })

  it("leaves preset registration to the manager instead of registering imperatively", async () => {
    const { ctx, registerMcpServerPreset } = makeCtx()
    await stagehandMcp.activate(ctx)
    expect(registerMcpServerPreset).not.toHaveBeenCalled()
  })

  it("points the self-hosted preset at the package that actually exists on npm", () => {
    // `@browserbasehq/mcp-stagehand` is a hard 404 and
    // `@browserbasehq/mcp-server-browserbase` is deprecated — either one makes
    // `npx` fail at spawn on every launch.
    const selfHosted = preset("stagehand")
    expect(selfHosted?.config.command).toBe("npx")
    const args = selfHosted?.config.args?.join(" ") ?? ""
    expect(args).toContain("@browserbasehq/mcp@")
    expect(args).not.toContain("mcp-stagehand")
    expect(args).not.toContain("mcp-server-browserbase")
  })

  it("marks the self-hosted Browserbase / model key fields as env-placed secrets", () => {
    const byKey: Record<string, unknown> = Object.fromEntries(
      (preset("stagehand")?.fields ?? []).map((f) => [f.key, f])
    )
    expect(byKey.BROWSERBASE_API_KEY).toMatchObject({ placement: "env", secret: true })
    // v3 defaults to google/gemini-2.5-flash-lite, not GPT-4o.
    expect(byKey.GEMINI_API_KEY).toMatchObject({ placement: "env", secret: true })
    expect(byKey.OPENAI_API_KEY).toBeUndefined()
    expect(byKey.BROWSERBASE_PROJECT_ID).toMatchObject({ placement: "env" })
  })

  it("authenticates the hosted preset through a vaultable request header", () => {
    // Upstream's preferred hosted auth is `x-bb-api-key` / `Authorization:
    // Bearer` — the `browserbaseApiKey` query param is a deprecated fallback.
    // `x-bb-api-key` matches the vault's SENSITIVE_NAME, so
    // `externalizeMcpSecrets` moves it into the credential store on add.
    const hosted = preset("stagehand-hosted")
    expect(hosted?.transport).toBe("http")
    expect(hosted?.config.url).toBe("https://mcp.browserbase.com/mcp")
    expect(hosted?.fields).toEqual([
      expect.objectContaining({ key: "url", placement: "url" }),
      expect.objectContaining({ key: "x-bb-api-key", placement: "header", secret: true }),
    ])
    // No field may steer the API key into the URL.
    expect(JSON.stringify(hosted)).not.toContain("browserbaseApiKey")
  })

  it("only points model keys at spellings the credential vault stores", () => {
    // `lib/mcp/credentials.ts` vaults any URL query or CLI flag whose name
    // ends in `api[_-]?key` (pinned there by "vaults vendor-prefixed API key
    // names"). The guidance must stay on exactly those spellings and say so.
    const hostedUrl = preset("stagehand-hosted")?.fields.find((f) => f.key === "url")
    expect(hostedUrl?.description).toContain("modelApiKey=")
    expect(hostedUrl?.description).toMatch(/credential vault/)
    const modelKey = preset("stagehand")?.fields.find((f) => f.key === "GEMINI_API_KEY")
    expect(modelKey?.description).toContain("--modelApiKey")
    expect(modelKey?.description).toMatch(/credential vault/)
    for (const entry of manifestJson.mcpServerPresets) {
      for (const field of entry.fields) {
        for (const name of field.description?.match(/[?&-]-?([A-Za-z_-]*[Kk]ey)\b/g) ?? []) {
          expect(name).toMatch(/api[_-]?key$/i)
        }
      }
    }
  })

  it("is plugin.json, unchanged", () => {
    expect(manifest).toEqual(manifestJson)
    expect(manifest.commands?.map((c) => c.id)).toEqual(["stagehand"])
    expect(manifest.permissions).toEqual(expect.arrayContaining(["extension:ui", "shell:execute"]))
    expect(manifest.shellCommands).toEqual(["node", "npx"])
    expect(manifest.mcpServerPresets?.map((p) => p.id)).toEqual(["stagehand-hosted", "stagehand"])
    // Bare keys — the manager adds the `plugin.<id>.` prefix on merge.
    const locales = manifestJson.i18n.locales
    expect(Object.keys(locales).sort()).toEqual(["en", "zh-CN"])
    expect(Object.keys(locales.en).every((key) => !key.startsWith("plugin."))).toBe(true)
  })

  it("keeps en/zh-CN plugin bundles in key parity", () => {
    const { en, "zh-CN": zh } = manifestJson.i18n.locales
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it("publishes the shell and in-app navigation for the modal and clears them on dispose", async () => {
    const { ctx, disposers, navigate } = makeCtx()
    await stagehandMcp.activate(ctx)
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
    expect(stagehandMcp.deactivate).toBeUndefined()
  })

  it("declares its slash command and lazy activation in plugin.json", async () => {
    const { ctx } = makeCtx()
    const hooks = await stagehandMcp.activate(ctx)
    expect(typeof hooks?.onCommand).toBe("function")
    expect(manifestJson.commands?.map((c) => c.id)).toEqual(["stagehand"])
    expect(manifestJson.activationEvents).toContain("onCommand:stagehand")
  })

  it("handles /stagehand by opening the setup modal, and declines other commands", async () => {
    const { ctx, openModal } = makeCtx()
    const hooks = await stagehandMcp.activate(ctx)

    expect(await hooks?.onCommand?.("not-mine", [])).toBe(false)
    expect(openModal).not.toHaveBeenCalled()

    const result = await hooks?.onCommand?.("stagehand", [])
    expect(openModal).toHaveBeenCalledTimes(1)
    expect(openModal.mock.calls[0][2]).toEqual({ size: "lg" })
    expect(result).toEqual({ handled: true, message: "t:command.opened" })
  })
})
