/** @jest-environment node */

import type { DiskPluginEntry } from "../plugin/host"
import type { VsCodeActivationEvent } from "@/types/plugin/plugin-vscode"
import { createNodePluginRuntimeAdapter } from "./plugin-runtime-adapter"

const manifest = {
  id: "demo",
  name: "Demo",
  description: "Demo plugin",
  version: "1.0.0",
  type: "frontend" as const,
  main: "index.js",
  capabilities: [],
}

function harness(
  entry: DiskPluginEntry | null = { id: "demo", dir: "/data/demo", manifest, supported: true }
) {
  const manager = {
    registerDiskPlugin: jest.fn(async () => undefined),
    loadPlugin: jest.fn(async () => undefined),
    enablePlugin: jest.fn(async () => undefined),
    unloadPlugin: jest.fn(async () => undefined),
  }
  const store = {
    plugins: { demo: { status: "enabled" } } as Record<string, { status: string }>,
    uninstallPlugin: jest.fn(async () => undefined),
  }
  const dispose = jest.fn(async () => undefined)
  const adapter = createNodePluginRuntimeAdapter({
    ensure: async () => ({ ok: true, toolCount: 1 }),
    discover: async () => (entry ? [entry] : []),
    manager: async () => manager,
    store: async () => store,
    dispose,
  })
  return { adapter, manager, store, dispose }
}

it("fails startup visibly when the canonical PluginManager cannot boot", async () => {
  const adapter = createNodePluginRuntimeAdapter({
    ensure: async () => ({ ok: false, toolCount: 0, error: "indexeddb unavailable" }),
  })
  await expect(adapter.start()).rejects.toThrow("indexeddb unavailable")
})

it("registers and activates persisted WASM plugins during brain startup", async () => {
  const wasmEntry: DiskPluginEntry = {
    id: "demo",
    dir: "/data/demo",
    manifest: {
      ...manifest,
      type: "wasm",
      main: undefined,
      wasmMain: "plugin.wasm",
      wasm: { apiVersion: "0.1.0" },
      runtimeCompatibility: { tauri: { availability: "supported" } },
    },
    supported: false,
  }
  const { adapter, manager } = harness(wasmEntry)

  await adapter.start()

  expect(manager.registerDiskPlugin).toHaveBeenCalledWith(wasmEntry.manifest, "/data/demo")
  expect(manager.loadPlugin).toHaveBeenCalledWith("demo")
  expect(manager.enablePlugin).toHaveBeenCalledWith("demo")
})

it.each([
  {
    type: "python" as const,
    manifest: {
      ...manifest,
      type: "python" as const,
      main: undefined,
      pythonMain: "main.py",
      runtimeCompatibility: { tauri: { availability: "supported" as const } },
    },
  },
  {
    type: "hybrid" as const,
    manifest: {
      ...manifest,
      type: "hybrid" as const,
      pythonMain: "main.py",
      runtimeCompatibility: { tauri: { availability: "supported" as const } },
    },
  },
  {
    type: "vscode-extension" as const,
    manifest: {
      ...manifest,
      type: "vscode-extension" as const,
      main: undefined,
      vscodeMain: "extension.js",
      vscodeExtension: {
        identifier: "demo",
        version: "1.0.0",
        engineVscode: ">=1.90.0",
        vsixSha256: "a".repeat(64),
        source: "vsix-upload" as const,
        bundleFormat: "cjs" as const,
        activationEvents: ["*" as VsCodeActivationEvent],
      },
      runtimeCompatibility: { tauri: { availability: "supported" as const } },
    },
  },
])("registers and activates persisted $type plugins during brain startup", async ({ manifest }) => {
  const entry: DiskPluginEntry = {
    id: "demo",
    dir: "/data/demo",
    manifest,
    supported: false,
  }
  const { adapter, manager } = harness(entry)

  await adapter.start()

  expect(manager.registerDiskPlugin).toHaveBeenCalledWith(entry.manifest, "/data/demo")
  expect(manager.loadPlugin).toHaveBeenCalledWith("demo")
  expect(manager.enablePlugin).toHaveBeenCalledWith("demo")
})

it("unloads, refreshes, loads, and enables an installed or restored plugin", async () => {
  const { adapter, manager } = harness()
  await adapter.reconcile({ action: "restored", pluginId: "demo", accountId: "account-a" })
  expect(manager.unloadPlugin).toHaveBeenCalledWith("demo")
  expect(manager.registerDiskPlugin).toHaveBeenCalledWith(manifest, "/data/demo")
  expect(manager.loadPlugin).toHaveBeenCalledWith("demo")
  expect(manager.enablePlugin).toHaveBeenCalledWith("demo")
})

it("unloads and removes only the brain projection after native uninstall", async () => {
  const { adapter, manager, store } = harness()
  await adapter.reconcile({ action: "uninstalled", pluginId: "demo" })
  expect(manager.unloadPlugin).toHaveBeenCalledWith("demo")
  expect(store.uninstallPlugin).toHaveBeenCalledWith("demo", {
    skipFileRemoval: true,
    viaManager: false,
  })
})

it("unloads every active plugin in reverse registration order on shutdown", async () => {
  const { adapter, manager, store, dispose } = harness()
  store.plugins = {
    first: { status: "enabled" },
    dormant: { status: "installed" },
    last: { status: "disabled" },
  }
  await adapter.stop?.()
  expect(manager.unloadPlugin.mock.calls).toEqual([["last"], ["first"]])
  expect(dispose).toHaveBeenCalledTimes(1)
})

it("rejects a missing or unsupported installed manifest instead of silently degrading", async () => {
  const missing = harness(null)
  await expect(
    missing.adapter.reconcile({ action: "installed", pluginId: "demo" })
  ).rejects.toThrow("manifest is missing")

  const unsupported = harness({
    id: "demo",
    dir: "/data/demo",
    manifest: {
      ...manifest,
      // Forward-safety: a future isolated runtime must be explicitly wired
      // before the brain accepts it.
      type: "future-native" as never,
    },
    supported: false,
  })
  await expect(
    unsupported.adapter.reconcile({ action: "installed", pluginId: "demo" })
  ).rejects.toThrow('Plugin type "future-native" is unavailable')
})
