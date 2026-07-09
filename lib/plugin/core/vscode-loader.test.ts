/** @jest-environment jsdom */
/**
 * Tests for `vscode-loader.ts`.
 *
 * This suite toggles `window.__TAURI_INTERNALS__` to exercise the desktop vs
 * browser branches, so it needs the jsdom environment — the node/jsdom
 * test-speed split otherwise routes bare `.ts` files to the node project
 * (no `window`), which silently fails every Tauri-mode assertion.
 *
 * Two scenarios:
 *  1. Browser stub mode (no Tauri internals) — activate() logs a warning
 *     and returns an empty result.
 *  2. Tauri mode — invoke is mocked; we verify the right commands fire
 *     with the right payloads, and that activate/deactivate route to them.
 */

import type { PluginManifest } from "@/types/plugin"

// jsdom always provides a `window` object that is non-configurable, so we
// can't redefine it. The loader checks for the `__TAURI_INTERNALS__`
// property, so we toggle that property instead.
const win = globalThis.window as (Window & { __TAURI_INTERNALS__?: unknown }) | undefined

function installTauriWindow() {
  if (win) win.__TAURI_INTERNALS__ = {}
}

function removeTauriWindow() {
  if (win) delete win.__TAURI_INTERNALS__
}

const baseManifest: PluginManifest = {
  id: "cognia.test-ext",
  name: "Test Extension",
  version: "1.0.0",
  description: "fixture",
  type: "vscode-extension",
  capabilities: ["tools"],
  vscodeMain: "out/extension.js",
  vscodeExtension: {
    identifier: "cognia.test-ext",
    version: "1.0.0",
    engineVscode: ">=1.74.0",
    vsixSha256: "a".repeat(64),
    source: "vsix-upload",
    bundleFormat: "cjs",
    activationEvents: ["onCommand:test.hello"],
  },
}

const mockLogger = {
  trace: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  child: jest.fn().mockReturnThis(),
}

const mockContext = {
  pluginId: "cognia.test-ext",
  pluginPath: "/tmp/cognia/plugins/cognia.test-ext",
  config: {},
  logger: mockLogger,
} as unknown as Parameters<
  NonNullable<
    Awaited<ReturnType<typeof import("./vscode-loader").loadVscodeDefinition>>["activate"]
  >
>[0]

describe("vscode-loader — browser stub mode", () => {
  beforeEach(() => {
    removeTauriWindow()
    jest.resetModules()
    jest.clearAllMocks()
  })

  it("returns a stub definition when Tauri internals are absent", async () => {
    const { isVscodeHostAvailable, loadVscodeDefinition } = await import("./vscode-loader")
    expect(isVscodeHostAvailable()).toBe(false)
    const def = await loadVscodeDefinition(baseManifest, "/tmp/plugin")
    expect(def.manifest).toBe(baseManifest)
    const result = await def.activate!(mockContext)
    expect(result).toEqual({})
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/requires the Tauri desktop runtime/i)
    )
    await def.deactivate!(mockContext)
    // deactivate is a no-op in stub mode — no throw is the assertion.
  })

  it("rejects a manifest with neither vscodeMain nor themes", async () => {
    const { loadVscodeDefinition } = await import("./vscode-loader")
    const bad: PluginManifest = { ...baseManifest, vscodeMain: undefined }
    await expect(loadVscodeDefinition(bad, "/tmp/x")).rejects.toThrow(
      /no 'vscodeMain' entry point/i
    )
  })

  it("rejects a manifest missing vscodeExtension.identifier", async () => {
    const { loadVscodeDefinition } = await import("./vscode-loader")
    const bad: PluginManifest = { ...baseManifest, vscodeExtension: undefined }
    await expect(loadVscodeDefinition(bad, "/tmp/x")).rejects.toThrow(
      /vscodeExtension\.identifier/i
    )
  })
})

describe("vscode-loader — Tauri mode", () => {
  beforeEach(() => {
    installTauriWindow()
    jest.resetModules()
    jest.clearAllMocks()
    // The dispatcher wires itself to `@tauri-apps/api/event::listen` the
    // first time loadVscodeDefinition runs in Tauri mode. Mock it here so
    // we don't pull in the real Tauri runtime.
    jest.doMock("@tauri-apps/api/event", () => ({
      listen: jest.fn(async () => () => {}),
    }))
  })

  afterAll(() => {
    removeTauriWindow()
  })

  it("calls plugin_load_vscode + plugin_activate_vscode via Tauri invoke", async () => {
    const invoke = jest.fn(async (cmd: string) => {
      if (cmd === "plugin_load_vscode") return undefined
      if (cmd === "plugin_activate_vscode") {
        return {
          registeredCommands: ["test.hello"],
          registeredWebviewViews: [],
          registeredLanguageProviders: [],
          sidecarPid: 12345,
        }
      }
      throw new Error(`unexpected command ${cmd}`)
    })
    jest.doMock("@tauri-apps/api/core", () => ({ invoke }))

    const { loadVscodeDefinition } = await import("./vscode-loader")
    const def = await loadVscodeDefinition(baseManifest, "/tmp/plugin")
    expect(invoke).toHaveBeenCalledWith(
      "plugin_load_vscode",
      expect.objectContaining({
        pluginId: "cognia.test-ext",
        pluginPath: "/tmp/plugin",
      })
    )

    await def.activate!(mockContext)
    expect(invoke).toHaveBeenCalledWith(
      "plugin_activate_vscode",
      expect.objectContaining({ pluginId: "cognia.test-ext" })
    )
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringMatching(/activated/i),
      expect.objectContaining({ sidecarPid: 12345 })
    )

    await def.deactivate!(mockContext)
    expect(invoke).toHaveBeenCalledWith("plugin_deactivate_vscode", {
      pluginId: "cognia.test-ext",
    })
  })

  it("propagates Tauri load failures as Error with a useful message", async () => {
    const invoke = jest.fn(async () => {
      throw new Error("sidecar crashed during spawn")
    })
    jest.doMock("@tauri-apps/api/core", () => ({ invoke }))

    const { loadVscodeDefinition } = await import("./vscode-loader")
    await expect(loadVscodeDefinition(baseManifest, "/tmp/plugin")).rejects.toThrow(
      /Failed to load VS Code extension cognia\.test-ext.*sidecar crashed/i
    )
  })

  it("propagates Tauri activate failures and re-throws", async () => {
    const invoke = jest.fn(async (cmd: string) => {
      if (cmd === "plugin_load_vscode") return undefined
      if (cmd === "plugin_activate_vscode") {
        throw new Error("activate boom")
      }
      return undefined
    })
    jest.doMock("@tauri-apps/api/core", () => ({ invoke }))

    const { loadVscodeDefinition } = await import("./vscode-loader")
    const def = await loadVscodeDefinition(baseManifest, "/tmp/plugin")
    await expect(def.activate!(mockContext)).rejects.toThrow(/activate boom/)
  })

  it("swallows deactivate failures (warn + continue)", async () => {
    const invoke = jest.fn(async (cmd: string) => {
      if (cmd === "plugin_load_vscode") return undefined
      if (cmd === "plugin_activate_vscode")
        return {
          registeredCommands: [],
          registeredWebviewViews: [],
          registeredLanguageProviders: [],
          sidecarPid: 1,
        }
      if (cmd === "plugin_deactivate_vscode") throw new Error("deactivate boom")
      return undefined
    })
    jest.doMock("@tauri-apps/api/core", () => ({ invoke }))

    const { loadVscodeDefinition } = await import("./vscode-loader")
    const def = await loadVscodeDefinition(baseManifest, "/tmp/plugin")
    await def.activate!(mockContext)
    // Should not throw.
    await expect(def.deactivate!(mockContext)).resolves.toBeUndefined()
  })

  it("returns a non-sidecar definition for theme-only extensions", async () => {
    const invoke = jest.fn()
    jest.doMock("@tauri-apps/api/core", () => ({ invoke }))

    const { loadVscodeDefinition } = await import("./vscode-loader")
    const themeOnly: PluginManifest = {
      ...baseManifest,
      vscodeMain: undefined,
      themes: [{ id: "t", name: "T", vscodeJsonPath: "themes/t.json" }],
    }
    const def = await loadVscodeDefinition(themeOnly, "/tmp/plugin")
    expect(invoke).not.toHaveBeenCalled()
    await def.activate!(mockContext)
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringMatching(/theme-only.*activated/i))
  })

  it("invokeVscodeRpc round-trips a JSON payload", async () => {
    const invoke = jest.fn(async () => JSON.stringify({ ok: true, count: 7 }))
    jest.doMock("@tauri-apps/api/core", () => ({ invoke }))

    const { invokeVscodeRpc } = await import("./vscode-loader")
    const result = await invokeVscodeRpc<{ ok: boolean; count: number }>(
      "cognia.test-ext",
      "workspace.fs.readFile",
      { path: "/foo" }
    )
    expect(invoke).toHaveBeenCalledWith(
      "plugin_invoke_vscode_rpc",
      expect.objectContaining({
        pluginId: "cognia.test-ext",
        method: "workspace.fs.readFile",
      })
    )
    expect(result).toEqual({ ok: true, count: 7 })
  })

  it("invokeVscodeRpc passes through non-JSON results", async () => {
    const invoke = jest.fn(async () => undefined)
    jest.doMock("@tauri-apps/api/core", () => ({ invoke }))
    const { invokeVscodeRpc } = await import("./vscode-loader")
    const result = await invokeVscodeRpc("cognia.test-ext", "noop", {})
    expect(result).toBeUndefined()
  })

  it("unloadVscodeExtension is idempotent on failure", async () => {
    const invoke = jest.fn(async () => {
      throw new Error("already gone")
    })
    jest.doMock("@tauri-apps/api/core", () => ({ invoke }))
    const { unloadVscodeExtension } = await import("./vscode-loader")
    await expect(unloadVscodeExtension("cognia.test-ext")).resolves.toBeUndefined()
  })

  it("bootstraps configureMonacoBridge with monaco-editor + dispatchRpc on first load", async () => {
    // `Promise<unknown>` widens the return so `mockResolvedValueOnce` can
    // surface the JSON string the rpc dispatch path returns later in the
    // test without re-inferring the activate-response shape.
    const invoke = jest.fn(async (cmd: string): Promise<unknown> => {
      if (cmd === "plugin_load_vscode") return undefined
      if (cmd === "plugin_activate_vscode")
        return {
          registeredCommands: [],
          registeredWebviewViews: [],
          registeredLanguageProviders: [],
          sidecarPid: 1,
        }
      return undefined
    })
    jest.doMock("@tauri-apps/api/core", () => ({ invoke }))

    const fakeLanguages = { registerCompletionItemProvider: jest.fn() }
    const fakeSetModelMarkers = jest.fn()
    jest.doMock("monaco-editor", () => ({
      languages: fakeLanguages,
      editor: { setModelMarkers: fakeSetModelMarkers },
    }))

    const configureMonacoBridge = jest.fn()
    jest.doMock("@/lib/plugin/vscode-shim/monaco-bridge", () => ({
      configureMonacoBridge,
    }))

    const { loadVscodeDefinition } = await import("./vscode-loader")
    await loadVscodeDefinition(baseManifest, "/tmp/plugin")

    expect(configureMonacoBridge).toHaveBeenCalledTimes(1)
    const arg = configureMonacoBridge.mock.calls[0][0]
    expect(arg.monacoApi).toBeDefined()
    expect(typeof arg.dispatchRpc).toBe("function")
    // dispatchRpc closure routes through plugin_invoke_vscode_rpc.
    invoke.mockResolvedValueOnce(JSON.stringify({ ok: true }))
    const out = await arg.dispatchRpc("cognia.test-ext", "anyMethod", { x: 1 })
    expect(invoke).toHaveBeenCalledWith(
      "plugin_invoke_vscode_rpc",
      expect.objectContaining({ pluginId: "cognia.test-ext", method: "anyMethod" })
    )
    expect(out).toEqual({ ok: true })
  })

  it("survives monaco-editor failing to load (logs warn + continues activation)", async () => {
    const invoke = jest.fn(async (cmd: string) => {
      if (cmd === "plugin_load_vscode") return undefined
      if (cmd === "plugin_activate_vscode")
        return {
          registeredCommands: [],
          registeredWebviewViews: [],
          registeredLanguageProviders: [],
          sidecarPid: 1,
        }
      return undefined
    })
    jest.doMock("@tauri-apps/api/core", () => ({ invoke }))
    // Simulate an environment where the lazy import throws (e.g. monaco
    // assets are missing in CI).
    jest.doMock("monaco-editor", () => {
      throw new Error("monaco unavailable")
    })

    const configureMonacoBridge = jest.fn()
    jest.doMock("@/lib/plugin/vscode-shim/monaco-bridge", () => ({
      configureMonacoBridge,
    }))

    const { loadVscodeDefinition } = await import("./vscode-loader")
    await expect(loadVscodeDefinition(baseManifest, "/tmp/plugin")).resolves.toBeDefined()
    expect(configureMonacoBridge).not.toHaveBeenCalled()
  })
})

describe("vscode-loader — ensureDispatcherConfigured export", () => {
  beforeEach(() => {
    removeTauriWindow()
    jest.resetModules()
    jest.clearAllMocks()
  })

  it("is exported so the editor LSP runtime can bootstrap it standalone", async () => {
    // The export is the contract `ensureEditorLspRuntime` depends on to wire
    // the dispatcher + monaco-bridge + LSP registry without a .vsix load.
    const mod = await import("./vscode-loader")
    expect(typeof mod.ensureDispatcherConfigured).toBe("function")
  })

  it("no-ops safely and idempotently off the Tauri host", async () => {
    // Off-host it returns early (isVscodeHostAvailable() === false) without
    // pulling any Tauri/monaco import — safe to call repeatedly.
    const { ensureDispatcherConfigured } = await import("./vscode-loader")
    await expect(ensureDispatcherConfigured()).resolves.toBeUndefined()
    await expect(ensureDispatcherConfigured()).resolves.toBeUndefined()
  })
})

describe("vscode-loader — invokeVscodeRpc without Tauri", () => {
  beforeEach(() => {
    removeTauriWindow()
    jest.resetModules()
  })

  it("throws when Tauri is unavailable", async () => {
    const { invokeVscodeRpc } = await import("./vscode-loader")
    await expect(invokeVscodeRpc("x", "m", {})).rejects.toThrow(/host unavailable/i)
  })

  it("unloadVscodeExtension is a no-op when Tauri is unavailable", async () => {
    const { unloadVscodeExtension } = await import("./vscode-loader")
    await expect(unloadVscodeExtension("x")).resolves.toBeUndefined()
  })
})
