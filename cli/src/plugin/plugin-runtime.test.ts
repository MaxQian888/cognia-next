/**
 * @jest-environment node
 */
import {
  __resetPluginRuntimeForTesting,
  ensurePluginRuntime,
  installPluginRuntimeShims,
} from "./plugin-runtime"

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
})

describe("ensurePluginRuntime", () => {
  beforeEach(() => __resetPluginRuntimeForTesting())

  it("runs the bootstrap steps in order and reports the tool count", async () => {
    const calls: string[] = []
    const result = await ensurePluginRuntime({
      installShims: () => calls.push("shims"),
      installIndexedDb: async () => void calls.push("idb"),
      configureGuard: () => calls.push("guard"),
      initManager: async () => void calls.push("init"),
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
})
