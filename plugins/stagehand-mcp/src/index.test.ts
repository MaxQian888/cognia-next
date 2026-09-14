import type { PluginContext } from "@cognia/plugin-sdk"
import { findPluginManifestParityIssues } from "@cognia/plugin-sdk/manifest"

import stagehandMcp from "./index"
import { getPluginShell, setPluginShell } from "./runtime"
import manifestJson from "../plugin.json"

function makeCtx(overrides: Partial<PluginContext> = {}) {
  const presets: Array<{ id: string }> = []
  const disposers: Array<() => void> = []
  const openModal = jest.fn()
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-stagehand-mcp",
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

describe("stagehand-mcp (built-in)", () => {
  afterEach(() => {
    // The shell slot is module-global — never leak it across tests.
    setPluginShell(undefined)
  })

  it("activate registers the hosted and self-hosted presets imperatively", async () => {
    const { ctx, presets } = makeCtx()
    await stagehandMcp.activate?.(ctx)
    expect(presets).toEqual([
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

  it("points the self-hosted preset at the package that actually exists on npm", () => {
    // `@browserbasehq/mcp-stagehand` is a hard 404 and
    // `@browserbasehq/mcp-server-browserbase` is deprecated — either one makes
    // `npx` fail at spawn on every launch.
    const manifest = stagehandMcp.manifest as unknown as {
      mcpServerPresets: Array<{ id: string; config: { command?: string; args?: string[] } }>
    }
    const selfHosted = manifest.mcpServerPresets.find((p) => p.id === "stagehand")
    expect(selfHosted?.config.command).toBe("npx")
    const args = selfHosted?.config.args?.join(" ") ?? ""
    expect(args).toContain("@browserbasehq/mcp@")
    expect(args).not.toContain("mcp-stagehand")
    expect(args).not.toContain("mcp-server-browserbase")
  })

  it("marks the self-hosted Browserbase / model key fields as env-placed secrets", () => {
    const manifest = stagehandMcp.manifest as unknown as {
      mcpServerPresets: Array<{
        id: string
        fields: Array<{ key: string; placement: string; secret?: boolean }>
      }>
    }
    const preset = manifest.mcpServerPresets.find((p) => p.id === "stagehand")
    const byKey = Object.fromEntries((preset?.fields ?? []).map((f) => [f.key, f]))
    expect(byKey.BROWSERBASE_API_KEY).toMatchObject({ placement: "env", secret: true })
    // v3 defaults to google/gemini-2.5-flash-lite, not GPT-4o.
    expect(byKey.GEMINI_API_KEY).toMatchObject({ placement: "env", secret: true })
    expect(byKey.OPENAI_API_KEY).toBeUndefined()
    expect(byKey.BROWSERBASE_PROJECT_ID).toMatchObject({ placement: "env" })
  })

  it("authenticates the hosted preset through a vaultable request header", () => {
    // Upstream's preferred hosted auth is `x-bb-api-key` / `Authorization:
    // Bearer` — the `browserbaseApiKey` query param is a deprecated fallback
    // whose name escapes the vault's SENSITIVE_QUERY match, so it would
    // persist the key in plaintext. `x-bb-api-key` matches SENSITIVE_NAME, so
    // `externalizeMcpSecrets` moves it into the credential store on add.
    const manifest = stagehandMcp.manifest as unknown as {
      mcpServerPresets: Array<{
        id: string
        transport: string
        config: Record<string, unknown>
        fields: Array<{ key: string; placement: string; secret?: boolean }>
      }>
    }
    const hosted = manifest.mcpServerPresets.find((p) => p.id === "stagehand-hosted")
    expect(hosted?.transport).toBe("http")
    expect(hosted?.config.url).toBe("https://mcp.browserbase.com/mcp")
    expect(hosted?.fields).toEqual([
      expect.objectContaining({ key: "url", placement: "url" }),
      expect.objectContaining({ key: "x-bb-api-key", placement: "header", secret: true }),
    ])
    // No field may steer the API key into the URL.
    expect(JSON.stringify(hosted)).not.toContain("browserbaseApiKey")
  })

  it("merges plugin.json, the presets, and the i18n bundle into the manifest", () => {
    const manifest = stagehandMcp.manifest as unknown as {
      id: string
      commands: Array<{ id: string }>
      permissions: string[]
      shellCommands: string[]
      mcpServerPresets: Array<{ id: string }>
      i18n: { locales: Record<string, Record<string, string>> }
    }
    expect(manifest.id).toBe("cognia-stagehand-mcp")
    // plugin.json fields must survive the module-over-JSON merge — a
    // hand-written subset would silently drop them.
    expect(manifest.commands.map((c) => c.id)).toEqual(["stagehand"])
    expect(manifest.permissions).toEqual(expect.arrayContaining(["extension:ui", "shell:execute"]))
    expect(manifest.shellCommands).toEqual(["node", "npx"])
    expect(manifest.mcpServerPresets.map((p) => p.id)).toEqual(["stagehand-hosted", "stagehand"])
    // Bare keys — the manager adds the `plugin.<id>.` prefix on merge.
    expect(Object.keys(manifest.i18n.locales).sort()).toEqual(["en", "zh-CN"])
    expect(Object.keys(manifest.i18n.locales.en).every((key) => !key.startsWith("plugin."))).toBe(
      true
    )
  })

  it("keeps the packaged plugin.json in parity with the module manifest", () => {
    // The packaged manifest is the install-time source of truth — a preset
    // declared only in TS would exist nowhere an installed copy can reach.
    expect(findPluginManifestParityIssues(manifestJson as never, stagehandMcp.manifest)).toEqual([])
  })

  it("keeps en/zh-CN plugin bundles in key parity", () => {
    const manifest = stagehandMcp.manifest as unknown as {
      i18n: { locales: Record<string, Record<string, string>> }
    }
    const en = Object.keys(manifest.i18n.locales.en).sort()
    const zh = Object.keys(manifest.i18n.locales["zh-CN"]).sort()
    expect(zh).toEqual(en)
  })

  it("publishes ctx.shell for the modal's environment check and clears it on dispose", async () => {
    const { ctx, disposers } = makeCtx()
    await stagehandMcp.activate?.(ctx)
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
    expect(stagehandMcp.deactivate).toBeUndefined()
  })

  it("declares its slash command and lazy activation in plugin.json", async () => {
    const { ctx } = makeCtx()
    const hooks = await stagehandMcp.activate?.(ctx)
    expect(typeof hooks?.onCommand).toBe("function")
    expect(manifestJson.commands?.map((c) => c.id)).toEqual(["stagehand"])
    expect(manifestJson.activationEvents).toContain("onCommand:stagehand")
  })

  it("handles /stagehand by opening the setup modal, and declines other commands", async () => {
    const { ctx, openModal } = makeCtx()
    const hooks = await stagehandMcp.activate?.(ctx)

    expect(await hooks?.onCommand?.("not-mine", [])).toBe(false)
    expect(openModal).not.toHaveBeenCalled()

    const result = await hooks?.onCommand?.("stagehand", [])
    expect(openModal).toHaveBeenCalledTimes(1)
    expect(openModal.mock.calls[0][2]).toEqual({ size: "lg" })
    expect(result).toEqual({ handled: true, message: expect.any(String) })
  })

  it("returns a localized fallback message when the host has no modal API", async () => {
    const { ctx, openModal } = makeCtx({ modal: undefined })
    const t = jest.fn((key: string) => `translated:${key}`)
    ;(ctx as { i18n?: unknown }).i18n = { t }
    const hooks = await stagehandMcp.activate?.(ctx)
    const result = await hooks?.onCommand?.("stagehand", [])
    expect(openModal).not.toHaveBeenCalled()
    expect(result).toEqual({ handled: true, message: "translated:command.noModal" })
  })
})
