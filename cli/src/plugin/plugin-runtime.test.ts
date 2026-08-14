/**
 * @jest-environment node
 */
import {
  __resetPluginRuntimeForTesting,
  applyDisabledPluginsToManager,
  applyDisabledPluginsToStore,
  ensurePluginRuntime,
  installPluginRuntimeShims,
  pluginDiscoveryRoots,
} from "./plugin-runtime"

function makeStore(statuses: Record<string, string>) {
  const plugins = Object.fromEntries(
    Object.entries(statuses).map(([id, status]) => [id, { status }])
  ) as Record<string, { status: string }>
  return {
    plugins,
    setPluginStatus: (id: string, status: "enabled" | "disabled") => {
      plugins[id].status = status
    },
  }
}

describe("installPluginRuntimeShims", () => {
  it("installs Map-backed storages, event no-ops, and seeds the plugin policy", () => {
    const g: Record<string, unknown> = {}
    installPluginRuntimeShims(g)
    const ls = g.localStorage as Storage
    ls.setItem("k", "v")
    expect(ls.getItem("k")).toBe("v")
    expect(ls.length).toBe(2) // "k" + the seeded policy
    expect(typeof (g.dispatchEvent as () => boolean)).toBe("function")
    expect((g.dispatchEvent as () => boolean)()).toBe(true)
    expect(typeof g.sessionStorage).toBe("object")
    expect(JSON.parse(ls.getItem("cognia.plugins.policy")!)).toEqual({
      signatureRequired: false,
      autoUpdate: false,
    })
  })

  it("is non-clobbering — keeps an existing storage / policy", () => {
    const existing = {
      store: new Map<string, string>([["cognia.plugins.policy", '{"signatureRequired":true}']]),
      getItem(k: string) {
        return this.store.get(k) ?? null
      },
      setItem(k: string, v: string) {
        this.store.set(k, v)
      },
      removeItem() {},
      clear() {},
      key() {
        return null
      },
      length: 1,
    }
    const g: Record<string, unknown> = { localStorage: existing }
    installPluginRuntimeShims(g)
    expect(g.localStorage).toBe(existing)
    // Existing policy preserved (not overwritten).
    expect(JSON.parse((g.localStorage as Storage).getItem("cognia.plugins.policy")!)).toEqual({
      signatureRequired: true,
    })
  })

  it("replaces Node-style storage accessors without invoking their getters", () => {
    const g: Record<string, unknown> = {}
    const getter = jest.fn(() => {
      throw new Error("warning-producing accessor was read")
    })
    Object.defineProperty(g, "localStorage", {
      configurable: true,
      get: getter,
    })

    expect(() => installPluginRuntimeShims(g)).not.toThrow()
    expect(getter).not.toHaveBeenCalled()
    expect((g.localStorage as Storage).getItem("cognia.plugins.policy")).not.toBeNull()
  })
})

describe("pluginDiscoveryRoots", () => {
  it("adds the shared headless data directory without duplicating existing roots", () => {
    expect(
      pluginDiscoveryRoots(
        { NODE_ENV: "test", COGNIA_DATA_DIR: "/data" },
        "/workspace",
        "/home/cognia"
      )
    ).toEqual(["/workspace", "/home/cognia", "/data"])
    expect(
      pluginDiscoveryRoots(
        { NODE_ENV: "test", COGNIA_DATA_DIR: "/home/cognia" },
        "/workspace",
        "/home/cognia"
      )
    ).toEqual(["/workspace", "/home/cognia"])
  })
})

describe("applyDisabledPluginsToStore", () => {
  beforeEach(() => __resetPluginRuntimeForTesting())

  it("disables every enabled plugin named in the set, leaving the rest enabled", () => {
    const store = makeStore({ a: "enabled", b: "enabled" })
    applyDisabledPluginsToStore(new Set(["b"]), store)
    expect(store.plugins.a.status).toBe("enabled")
    expect(store.plugins.b.status).toBe("disabled")
  })

  it("re-enables a plugin once it leaves the disabled set (toggle back on mid-session)", () => {
    const store = makeStore({ b: "enabled" })
    applyDisabledPluginsToStore(new Set(["b"]), store)
    expect(store.plugins.b.status).toBe("disabled")
    applyDisabledPluginsToStore(new Set(), store)
    expect(store.plugins.b.status).toBe("enabled")
  })

  it("never force-enables a plugin it did not disable (a load-failed plugin stays off)", () => {
    const store = makeStore({ c: "disabled" })
    applyDisabledPluginsToStore(new Set(), store)
    expect(store.plugins.c.status).toBe("disabled")
  })
})

describe("applyDisabledPluginsToManager", () => {
  it("routes persisted CLI disables through canonical teardown intent", async () => {
    const manager = { setPluginIntent: jest.fn(async () => undefined) }
    const store = makeStore({ a: "enabled", b: "enabled" })

    await applyDisabledPluginsToManager(new Set(["missing", "b"]), manager, store)

    expect(manager.setPluginIntent).toHaveBeenCalledTimes(1)
    expect(manager.setPluginIntent).toHaveBeenCalledWith("b", "disabled", "cli-state-restore")
  })
})

describe("ensurePluginRuntime", () => {
  beforeEach(() => __resetPluginRuntimeForTesting())

  it("registers disk plugins after applying the disabled set, before counting tools", async () => {
    const calls: string[] = []
    await ensurePluginRuntime({
      installShims: () => calls.push("shims"),
      installIndexedDb: async () => void calls.push("idb"),
      configureGuard: () => void calls.push("guard"),
      initManager: async () => void calls.push("init"),
      applyDisabled: () => void calls.push("disabled"),
      registerDisk: () => void calls.push("registerDisk"),
      manifestCount: () => {
        calls.push("count")
        return 0
      },
    })
    expect(calls).toEqual(["shims", "idb", "guard", "init", "disabled", "registerDisk", "count"])
  })

  it("runs registerDev after registerDisk and before counting tools", async () => {
    const calls: string[] = []
    await ensurePluginRuntime({
      installShims: () => {},
      installIndexedDb: async () => {},
      configureGuard: () => {},
      initManager: async () => {},
      applyDisabled: () => {},
      registerDisk: () => void calls.push("registerDisk"),
      registerDev: () => void calls.push("registerDev"),
      manifestCount: () => {
        calls.push("count")
        return 0
      },
    })
    expect(calls).toEqual(["registerDisk", "registerDev", "count"])
  })

  it("survives a dev-registration failure (best-effort, never throws)", async () => {
    const result = await ensurePluginRuntime({
      installShims: () => {},
      installIndexedDb: async () => {},
      configureGuard: () => {},
      initManager: async () => {},
      applyDisabled: () => {},
      registerDisk: () => {},
      registerDev: () => {
        throw new Error("dev boom")
      },
      manifestCount: () => 3,
    })
    expect(result).toEqual({ ok: true, toolCount: 3 })
  })

  it("survives a disk-registration failure (best-effort, never throws)", async () => {
    const result = await ensurePluginRuntime({
      installShims: () => {},
      installIndexedDb: async () => {},
      configureGuard: () => {},
      initManager: async () => {},
      applyDisabled: () => {},
      registerDisk: () => {
        throw new Error("disk boom")
      },
      manifestCount: () => 7,
    })
    expect(result).toEqual({ ok: true, toolCount: 7 })
  })

  it("runs the bootstrap steps in order and reports the tool count", async () => {
    const calls: string[] = []
    const result = await ensurePluginRuntime({
      installShims: () => calls.push("shims"),
      installIndexedDb: async () => void calls.push("idb"),
      configureGuard: () => void calls.push("guard"),
      initManager: async () => void calls.push("init"),
      applyDisabled: () => {},
      registerDisk: () => {},
      manifestCount: () => 53,
    })
    expect(result).toEqual({ ok: true, toolCount: 53 })
    expect(calls).toEqual(["shims", "idb", "guard", "init"])
  })

  it("caches — a second call does not re-run the bootstrap", async () => {
    let runs = 0
    const deps = {
      installShims: () => {},
      installIndexedDb: async () => {},
      configureGuard: () => void runs++,
      initManager: async () => {},
      applyDisabled: () => {},
      registerDisk: () => {},
      manifestCount: () => 1,
    }
    await ensurePluginRuntime(deps)
    await ensurePluginRuntime(deps)
    expect(runs).toBe(1)
  })

  it("degrades gracefully — a bootstrap failure resolves to ok:false, never throws", async () => {
    const result = await ensurePluginRuntime({
      installShims: () => {},
      installIndexedDb: async () => {},
      configureGuard: () => {
        throw new Error("guard boom")
      },
      initManager: async () => {},
      manifestCount: () => 0,
    })
    expect(result).toEqual({ ok: false, toolCount: 0, error: "guard boom" })
  })

  it("enables the canonical Python runtime only for the supervised headless brain", async () => {
    jest.resetModules()
    ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
    const initializePluginManager = jest.fn(async () => undefined)
    const frontendImporter = jest.fn()
    jest.doMock("@/lib/plugin/core/manager", () => ({ initializePluginManager }))
    jest.doMock("./node-importer", () => ({
      makeNodeFrontendImporter: () => frontendImporter,
    }))

    const fresh = await import("./plugin-runtime")
    fresh.__resetPluginRuntimeForTesting()
    const result = await fresh.ensurePluginRuntime({
      installShims: () => {},
      installIndexedDb: async () => {},
      configureGuard: () => {},
      applyDisabled: () => {},
      registerDisk: () => {},
      manifestCount: () => 0,
    })

    expect(result.ok).toBe(true)
    expect(initializePluginManager).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeProfile: "headless",
        enablePython: true,
        frontendImporter,
        nodeHostInvoker: expect.any(Function),
        lifecycleStateAdapter: expect.objectContaining({
          read: expect.any(Function),
          write: expect.any(Function),
        }),
      })
    )

    delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
    jest.dontMock("@/lib/plugin/core/manager")
    jest.dontMock("./node-importer")
  })
})
