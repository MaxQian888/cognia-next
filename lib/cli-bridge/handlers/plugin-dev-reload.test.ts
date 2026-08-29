import type { PluginLifecycleCoordinatorSnapshot } from "@/lib/plugin/core/lifecycle-coordinator"

import {
  pluginDevReload,
  resolvePluginDevCapability,
  type PluginDevReloadDependencies,
} from "./plugin-dev-reload"

const mockProductionIsTauri = jest.fn(() => false)
let mockProductionSnapshots: PluginLifecycleCoordinatorSnapshot[] = []
const mockProductionManager = {
  scanPlugins: jest.fn(async () => []),
  reloadPlugin: jest.fn(async () => undefined),
  enablePlugin: jest.fn(async () => undefined),
  getPluginLifecycleSnapshots: jest.fn(() => mockProductionSnapshots),
}
const mockProductionPlugins: Record<string, unknown> = {}
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockProductionIsTauri() }))
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => mockProductionManager,
}))
jest.mock("@/lib/plugin/devtools/developer-mode", () => ({
  isDeveloperModeEnabled: () => true,
}))
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: { getState: () => ({ plugins: mockProductionPlugins }) },
}))

const baseSnapshot = (
  overrides: Partial<PluginLifecycleCoordinatorSnapshot> = {}
): PluginLifecycleCoordinatorSnapshot => ({
  managerId: "manager-1",
  pluginId: "demo.plugin",
  generation: 3,
  intent: "enabled",
  actual: "active",
  stateSince: 1,
  requiredServices: [],
  providedServices: [],
  currentProviders: [],
  effects: { active: 0, pending: 0, failed: 0, labels: [] },
  packageRevision: "1.2.3",
  source: "dev",
  configRevision: 1,
  ...overrides,
})

function createDependencies(
  options: {
    status?: "enabled" | "installed" | "disabled" | "suspended"
    before?: PluginLifecycleCoordinatorSnapshot
    after?: PluginLifecycleCoordinatorSnapshot
    developerMode?: boolean
    pluginMissing?: boolean
    version?: string
    pluginType?: string
    activationError?: unknown
    scanError?: Error
    delayedAfter?: PluginLifecycleCoordinatorSnapshot
    dirtyOnActivationError?: PluginLifecycleCoordinatorSnapshot
  } = {}
) {
  let snapshot = options.before ?? baseSnapshot()
  const reloadPlugin = jest.fn(async () => {
    if (options.activationError) {
      if (options.dirtyOnActivationError) snapshot = options.dirtyOnActivationError
      throw options.activationError
    }
    snapshot =
      options.after ?? (options.delayedAfter ? baseSnapshot() : baseSnapshot({ generation: 4 }))
  })
  const enablePlugin = jest.fn(async () => {
    if (options.activationError) {
      if (options.dirtyOnActivationError) snapshot = options.dirtyOnActivationError
      throw options.activationError
    }
    snapshot =
      options.after ?? (options.delayedAfter ? baseSnapshot() : baseSnapshot({ generation: 4 }))
  })
  const scanPlugins = jest.fn(async () => {
    if (options.scanError) throw options.scanError
    return []
  })
  const deps: PluginDevReloadDependencies = {
    isDesktop: () => true,
    isDeveloperModeEnabled: () => options.developerMode ?? true,
    getPlugin: () =>
      options.pluginMissing
        ? undefined
        : ({
            status: options.status ?? "enabled",
            manifest: {
              id: "demo.plugin",
              version: options.version ?? "1.2.3",
              type: options.pluginType ?? "frontend",
            },
          } as never),
    manager: {
      scanPlugins,
      reloadPlugin,
      enablePlugin,
      getPluginLifecycleSnapshots: () => [snapshot],
    },
    sleep: async () => {
      if (options.delayedAfter) snapshot = options.delayedAfter
    },
    timeoutMs: options.delayedAfter ? 100 : 0,
  }
  return { deps, reloadPlugin, enablePlugin, scanPlugins }
}

const payload = {
  schemaVersion: 1,
  sessionId: "550e8400-e29b-41d4-a716-446655440000",
  attempt: 2,
  pluginId: "demo.plugin",
  packageVersion: "1.2.3",
  artifactRevision: "sha256:abc123",
  activate: true,
}

describe("pluginDevReload", () => {
  beforeEach(() => {
    mockProductionIsTauri.mockReturnValue(false)
    mockProductionSnapshots = []
    mockProductionManager.scanPlugins.mockClear()
    mockProductionManager.reloadPlugin.mockReset()
    mockProductionManager.reloadPlugin.mockResolvedValue(undefined)
    mockProductionManager.enablePlugin.mockReset()
    mockProductionManager.enablePlugin.mockResolvedValue(undefined)
    mockProductionManager.getPluginLifecycleSnapshots.mockClear()
    for (const pluginId of Object.keys(mockProductionPlugins))
      delete mockProductionPlugins[pluginId]
  })

  test.each(["frontend", "python", "hybrid", "wasm", "vscode-extension"] as const)(
    "reports controlled Desktop reload capability for %s plugins",
    (pluginType) => {
      expect(resolvePluginDevCapability(pluginType, { desktop: true, dirty: false })).toEqual({
        reloadMode: "hot",
        logMode: "structured",
      })
    }
  )

  it("makes host and dirty runtime limits explicit", () => {
    expect(resolvePluginDevCapability("frontend", { desktop: false, dirty: false })).toEqual(
      expect.objectContaining({ reloadMode: "unsupported", reasonCode: "desktop_required" })
    )
    expect(resolvePluginDevCapability("python", { desktop: true, dirty: true })).toEqual(
      expect.objectContaining({ reloadMode: "restart-required", reasonCode: "runtime_dirty" })
    )
  })

  it("reloads an active plugin and returns a generation-backed activation proof", async () => {
    const { deps, reloadPlugin, enablePlugin } = createDependencies()

    await expect(pluginDevReload(payload, deps)).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        outcome: "activated",
        stage: "verify",
        pluginId: "demo.plugin",
        pluginType: "frontend",
        activationProof: {
          previousGeneration: 3,
          generation: 4,
          actualState: "active",
          packageVersion: "1.2.3",
          artifactRevision: "sha256:abc123",
          reloadMode: "hot",
        },
      })
    )
    expect(reloadPlugin).toHaveBeenCalledWith("demo.plugin", "cli-dev")
    expect(enablePlugin).not.toHaveBeenCalled()
  })

  it("does not treat discovery alone as a successful reload", async () => {
    const { deps } = createDependencies({ after: baseSnapshot({ generation: 3 }) })

    const result = await pluginDevReload(payload, deps)

    expect(result.ok).toBe(false)
    expect(result.outcome).toBe("failed")
    expect(result.error?.code).toBe("activation_timeout")
    expect(result.activationProof).toBeUndefined()
  })

  it("waits for a lifecycle transition that stabilizes after activation returns", async () => {
    const { deps } = createDependencies({ delayedAfter: baseSnapshot({ generation: 4 }) })

    const result = await pluginDevReload(payload, deps)

    expect(result.ok).toBe(true)
    expect(result.activationProof?.generation).toBe(4)
  })

  it("enables an inactive plugin when the dev request explicitly activates it", async () => {
    const { deps, reloadPlugin, enablePlugin } = createDependencies({ status: "disabled" })

    const result = await pluginDevReload(payload, deps)

    expect(result.ok).toBe(true)
    expect(enablePlugin).toHaveBeenCalledWith("demo.plugin", "cli-dev")
    expect(reloadPlugin).not.toHaveBeenCalled()
  })

  it("returns restart_required for an unresolved dirty runtime", async () => {
    const dirty = baseSnapshot({
      actual: "dirty",
      dirty: {
        runtime: "frontend",
        reason: "timeout",
        at: 1,
        message: "worker did not stop",
        labels: ["worker"],
      },
    })
    const { deps, reloadPlugin, enablePlugin } = createDependencies({ before: dirty })

    const result = await pluginDevReload(payload, deps)

    expect(result.ok).toBe(false)
    expect(result.outcome).toBe("restart_required")
    expect(result.error?.code).toBe("runtime_dirty")
    expect(reloadPlugin).not.toHaveBeenCalled()
    expect(enablePlugin).not.toHaveBeenCalled()
  })

  it("fails closed when global developer mode is disabled", async () => {
    const { deps, scanPlugins } = createDependencies({ developerMode: false })

    const result = await pluginDevReload(payload, deps)

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("developer_mode_required")
    expect(scanPlugins).not.toHaveBeenCalled()
  })

  it("returns a retriable error while the desktop runtime manager is starting", async () => {
    const { deps } = createDependencies()
    deps.manager = null

    const result = await pluginDevReload(payload, deps)

    expect(result.error).toEqual(
      expect.objectContaining({ code: "runtime_manager_unavailable", retriable: true })
    )
  })

  it("reports discovery failures for missing, stale, and unsupported installs", async () => {
    const scanFailure = await pluginDevReload(
      payload,
      createDependencies({ scanError: new Error("manifest index unavailable") }).deps
    )
    expect(scanFailure.error).toEqual(
      expect.objectContaining({ code: "discovery_failed", message: "manifest index unavailable" })
    )

    const missing = await pluginDevReload(payload, createDependencies({ pluginMissing: true }).deps)
    expect(missing.error?.code).toBe("plugin_not_found")

    const stale = await pluginDevReload(payload, createDependencies({ version: "1.2.2" }).deps)
    expect(stale.error?.code).toBe("plugin_version_mismatch")

    const unsupported = await pluginDevReload(
      payload,
      createDependencies({ pluginType: "unknown-runtime" }).deps
    )
    expect(unsupported.error?.code).toBe("unsupported_runtime")
    expect(unsupported.error?.retriable).toBe(false)
  })

  it("refuses to enable an inactive plugin unless activation is explicit", async () => {
    const { deps, enablePlugin } = createDependencies({ status: "installed" })

    const result = await pluginDevReload({ ...payload, activate: false }, deps)

    expect(result.error?.code).toBe("activation_not_requested")
    expect(enablePlugin).not.toHaveBeenCalled()
  })

  it("returns structured activation and runtime errors", async () => {
    const activationFailure = await pluginDevReload(
      payload,
      createDependencies({ activationError: new Error("loader crashed") }).deps
    )
    expect(activationFailure).toEqual(
      expect.objectContaining({
        ok: false,
        stage: "activate",
        error: expect.objectContaining({ code: "activation_failed", message: "loader crashed" }),
      })
    )

    const dirty = baseSnapshot({
      actual: "dirty",
      dirty: {
        runtime: "frontend",
        reason: "cleanup-failed",
        at: 2,
        message: "worker survived unload",
        labels: ["worker"],
      },
    })
    const dirtyFailure = await pluginDevReload(
      payload,
      createDependencies({
        activationError: new Error("unload failed"),
        dirtyOnActivationError: dirty,
      }).deps
    )
    expect(dirtyFailure).toEqual(
      expect.objectContaining({
        outcome: "restart_required",
        stage: "quiesce",
        error: expect.objectContaining({
          code: "runtime_dirty",
          message: "worker survived unload",
        }),
      })
    )

    const runtimeFailure = await pluginDevReload(
      payload,
      createDependencies({
        after: baseSnapshot({ actual: "error", lastError: "entrypoint rejected" }),
      }).deps
    )
    expect(runtimeFailure.error).toEqual(
      expect.objectContaining({ code: "activation_failed", message: "entrypoint rejected" })
    )
  })

  it("normalizes non-Error loader failures and accepts a host payload without a version hint", async () => {
    const activationFailure = await pluginDevReload(
      { ...payload, packageVersion: undefined },
      createDependencies({ activationError: "loader rejected" }).deps
    )

    expect(activationFailure.error).toEqual(
      expect.objectContaining({ code: "activation_failed", message: "loader rejected" })
    )
  })

  it("makes a non-desktop host unsupported before discovery", async () => {
    const { deps, scanPlugins } = createDependencies()
    deps.isDesktop = () => false

    const result = await pluginDevReload(payload, deps)

    expect(result.error?.code).toBe("unsupported_runtime")
    expect(result.error?.retriable).toBe(false)
    expect(scanPlugins).not.toHaveBeenCalled()
  })

  it("fails closed with the production host dependencies outside Tauri", async () => {
    const result = await pluginDevReload(payload)

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "unsupported_runtime" }),
      })
    )
  })

  it("uses the production manager, store, and sleep adapter on Desktop", async () => {
    mockProductionIsTauri.mockReturnValue(true)
    mockProductionPlugins["demo.plugin"] = {
      status: "enabled",
      manifest: { id: "demo.plugin", version: "1.2.3", type: "frontend" },
    }
    const before = baseSnapshot()
    const after = baseSnapshot({ generation: 4 })
    mockProductionSnapshots = [before]
    mockProductionManager.reloadPlugin.mockImplementation(async () => {
      setTimeout(() => {
        mockProductionSnapshots = [after]
      }, 1)
    })

    const result = await pluginDevReload(payload)

    expect(result.ok).toBe(true)
    expect(mockProductionManager.scanPlugins).toHaveBeenCalled()
    expect(mockProductionManager.reloadPlugin).toHaveBeenCalledWith("demo.plugin", "cli-dev")
  })
})
