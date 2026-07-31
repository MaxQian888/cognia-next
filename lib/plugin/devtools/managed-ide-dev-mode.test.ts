import type { Plugin } from "@/types/plugin"

import { ManagedIdeDevMode, type ManagedIdeDevModeDependencies } from "./managed-ide-dev-mode"

function plugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    source: "dev",
    path: "/plugins/acme",
    status: "enabled",
    manifest: {
      id: "acme",
      name: "Acme",
      version: "1.0.0",
      type: "frontend",
      description: "test",
      author: "Acme",
      capabilities: [],
      ide: { schemaVersion: 1, targets: ["pro-ide"] },
    },
    config: {},
    error: undefined,
    ...overrides,
  } as Plugin
}

function dependencies(
  overrides: Partial<ManagedIdeDevModeDependencies> = {}
): ManagedIdeDevModeDependencies & {
  fireReload(result: { pluginId: string; success: boolean; duration: number }): void
} {
  let reloadListener:
    ((result: { pluginId: string; success: boolean; duration: number }) => void) | undefined
  const value: ManagedIdeDevModeDependencies = {
    isEnabled: () => true,
    getPlugin: () => plugin(),
    prepareProxy: jest.fn(async () => ({ signature: "dev-signature" }) as never),
    hotReload: {
      setConfig: jest.fn(),
      startWatching: jest.fn(async () => undefined),
      stopWatching: jest.fn(async () => undefined),
      onReload: jest.fn((listener) => {
        reloadListener = listener
        return () => {
          reloadListener = undefined
        }
      }),
    },
    ...overrides,
  }
  return {
    ...value,
    fireReload: (result) => reloadListener?.(result as never),
  }
}

describe("ManagedIdeDevMode", () => {
  it("returns field-level diagnostics for proposal-gated manifest entries", () => {
    const devMode = new ManagedIdeDevMode(dependencies())
    const input = plugin()
    input.manifest.ide!.contributions = { notebookPreload: [] }
    expect(devMode.validate(input)).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "IDE_PROPOSED_API_UNSUPPORTED",
        field: "ide.contributions.notebookPreload",
      }),
    ])
  })

  it("rebuilds only local development plugins with the platform signer", async () => {
    const deps = dependencies()
    const devMode = new ManagedIdeDevMode(deps)
    await expect(devMode.rebuild(plugin())).resolves.toMatchObject({
      signature: "dev-signature",
    })
    await expect(devMode.rebuild(plugin({ source: "marketplace" }))).rejects.toThrow(
      "IDE_DEV_MODE_PLUGIN_SOURCE_REQUIRED"
    )
  })

  it("watches resources and rebuilds a temporary proxy after runtime reload", async () => {
    const deps = dependencies()
    const devMode = new ManagedIdeDevMode(deps)
    const rebuilt = jest.fn()
    devMode.onDidRebuild(rebuilt)
    await devMode.startWatching([plugin()])
    deps.fireReload({ pluginId: "acme", success: true, duration: 10 })
    await new Promise((resolve) => setImmediate(resolve))

    expect(deps.hotReload.startWatching).toHaveBeenCalledWith([
      expect.objectContaining({ source: "dev" }),
    ])
    expect(deps.prepareProxy).toHaveBeenCalled()
    expect(rebuilt).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "acme",
        artifact: expect.objectContaining({ signature: "dev-signature" }),
      })
    )
  })

  it("filters watch inputs, replaces the old listener, and stops cleanly", async () => {
    const removeReloadListener = jest.fn()
    const deps = dependencies({
      hotReload: {
        setConfig: jest.fn(),
        startWatching: jest.fn(async () => undefined),
        stopWatching: jest.fn(async () => undefined),
        onReload: jest.fn(() => removeReloadListener),
      },
    })
    const devMode = new ManagedIdeDevMode(deps)
    await devMode.startWatching([
      plugin(),
      plugin({ source: "marketplace" }),
      plugin({
        manifest: {
          ...plugin().manifest,
          id: "monaco-only",
          ide: { schemaVersion: 1, targets: ["monaco"] },
        },
      }),
    ])

    expect(deps.hotReload.stopWatching).toHaveBeenCalledTimes(1)
    expect(deps.hotReload.setConfig).toHaveBeenCalledWith({
      enabled: true,
      autoReload: true,
      preserveState: true,
    })
    expect(deps.hotReload.startWatching).toHaveBeenCalledWith([
      expect.objectContaining({ source: "dev" }),
    ])
    await devMode.stopWatching()
    expect(removeReloadListener).toHaveBeenCalledTimes(1)
    expect(deps.hotReload.stopWatching).toHaveBeenCalledTimes(2)
  })

  it("ignores reloads for removed plugins and reports proxy rebuild failures", async () => {
    const missing = dependencies({ getPlugin: () => undefined })
    const missingMode = new ManagedIdeDevMode(missing)
    const missingListener = jest.fn()
    missingMode.onDidRebuild(missingListener)
    await missingMode.startWatching([plugin()])
    missing.fireReload({ pluginId: "removed", success: true, duration: 1 })
    await new Promise((resolve) => setImmediate(resolve))
    expect(missingListener).not.toHaveBeenCalled()

    const failing = dependencies({
      prepareProxy: jest.fn(async () => {
        throw "signer offline"
      }),
    })
    const failingMode = new ManagedIdeDevMode(failing)
    const failureListener = jest.fn()
    failingMode.onDidRebuild(failureListener)
    await failingMode.startWatching([plugin()])
    failing.fireReload({ pluginId: "acme", success: false, duration: 1 })
    await new Promise((resolve) => setImmediate(resolve))
    expect(failureListener).toHaveBeenCalledWith({
      pluginId: "acme",
      diagnostics: [
        {
          severity: "error",
          code: "IDE_DEV_PROXY_REBUILD_FAILED",
          message: "signer offline",
        },
      ],
    })
  })

  it("exposes local RPC inspection, clearing, permission simulation, and listener disposal", () => {
    const devMode = new ManagedIdeDevMode(dependencies())
    expect(devMode.inspectRpc()).toEqual([])
    expect(() => devMode.clearRpc()).not.toThrow()
    const resetPermissions = devMode.simulatePermissions(() => false)
    expect(resetPermissions).toEqual(expect.any(Function))
    expect(() => resetPermissions()).not.toThrow()

    const listener = jest.fn()
    const removeListener = devMode.onDidRebuild(listener)
    removeListener()
    expect(listener).not.toHaveBeenCalled()
  })

  it("rejects rebuilding a manifest with validation errors", async () => {
    const deps = dependencies()
    const devMode = new ManagedIdeDevMode(deps)
    const invalid = plugin()
    invalid.manifest.ide!.contributions = { notebookPreload: [] }

    await expect(devMode.rebuild(invalid)).rejects.toThrow("IDE_PROPOSED_API_UNSUPPORTED")
    expect(deps.prepareProxy).not.toHaveBeenCalled()
  })

  it("fails closed while developer mode is disabled", async () => {
    const devMode = new ManagedIdeDevMode(dependencies({ isEnabled: () => false }))
    await expect(devMode.rebuild(plugin())).rejects.toThrow("IDE_DEV_MODE_DISABLED")
  })
})
