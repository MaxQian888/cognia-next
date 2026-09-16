/**
 * @jest-environment jsdom
 */
/**
 * The registry: one store, one liveness rule, one ordering, and a cleanup path
 * per authoring surface so the surfaces cannot sweep each other away.
 */

import {
  getInterceptor,
  hasInterceptors,
  listInterceptorPointsInUse,
  listInterceptorsForPoint,
  registerInterceptor,
  resolveInterceptorChain,
  subscribeInterceptorDiagnostics,
  unregisterInterceptor,
  unregisterInterceptorGeneration,
  unregisterInterceptorsForPlugin,
  unregisterInterceptorsForPluginSource,
  __resetInterceptorRegistryForTesting,
} from "./registry"
import { usePluginStore } from "@/stores/plugin-runtime"
import type { InterceptorRegistration } from "./types"

function make(
  registrationId: string,
  overrides: Partial<InterceptorRegistration> = {}
): InterceptorRegistration {
  return {
    registrationId,
    pluginId: "p1",
    pluginInstanceId: "p1#1",
    generation: 1,
    realmId: "global",
    pointId: "model.request.prepare",
    semantic: "transform",
    trustTier: "community",
    order: {},
    timeoutMs: 100,
    handler: (() => undefined) as never,
    source: "interceptors",
    runtime: "frontend",
    ...overrides,
  }
}

function setPluginStatus(pluginId: string, status: "enabled" | "disabled"): void {
  usePluginStore.setState((state) => ({
    plugins: {
      ...state.plugins,
      [pluginId]: { ...(state.plugins[pluginId] ?? {}), id: pluginId, status } as never,
    },
  }))
}

beforeEach(() => {
  __resetInterceptorRegistryForTesting()
  usePluginStore.setState({ plugins: {} } as never)
})

describe("registerInterceptor", () => {
  it("registers, resolves and disposes", () => {
    const dispose = registerInterceptor(make("a"))
    expect(getInterceptor("a")).toBeDefined()
    expect(hasInterceptors("model.request.prepare")).toBe(true)
    dispose()
    expect(getInterceptor("a")).toBeUndefined()
    expect(hasInterceptors("model.request.prepare")).toBe(false)
  })

  it("is idempotent under re-registration — a reload replaces, never stacks", () => {
    registerInterceptor(make("a", { timeoutMs: 10 }))
    registerInterceptor(make("a", { timeoutMs: 20 }))
    expect(listInterceptorsForPoint("model.request.prepare")).toHaveLength(1)
    expect(getInterceptor("a")?.timeoutMs).toBe(20)
  })

  it("reports every point with a registration", () => {
    registerInterceptor(make("a"))
    registerInterceptor(make("b", { pointId: "tool.execute", semantic: "around" }))
    expect(listInterceptorPointsInUse()).toEqual(["model.request.prepare", "tool.execute"])
  })
})

describe("resolveInterceptorChain", () => {
  it("drops a registration whose plugin is disabled", () => {
    registerInterceptor(make("a"))
    setPluginStatus("p1", "enabled")
    expect(resolveInterceptorChain("model.request.prepare").ordered).toHaveLength(1)
    setPluginStatus("p1", "disabled")
    expect(resolveInterceptorChain("model.request.prepare").ordered).toHaveLength(0)
  })

  it("drops a registration with neither a handler nor a handler reference", () => {
    const orphan = make("a")
    delete orphan.handler
    registerInterceptor(orphan)
    expect(resolveInterceptorChain("model.request.prepare").ordered).toHaveLength(0)
  })

  it("keeps an out-of-process registration that carries only a handlerRef", () => {
    const remote = make("a", { handlerRef: "py:handler#1" })
    delete remote.handler
    registerInterceptor(remote)
    expect(resolveInterceptorChain("model.request.prepare").ordered).toHaveLength(1)
  })

  it("refuses a registration whose semantic disagrees with the point", () => {
    // Mixing an observer into an `around` chain is how "my observer swallowed
    // the response" happens — so it is dropped and reported, never coerced.
    const diagnostics: string[] = []
    subscribeInterceptorDiagnostics((entries) => {
      for (const entry of entries) diagnostics.push(entry.code)
    })
    registerInterceptor(make("a", { pointId: "tool.execute", semantic: "observe" }))
    expect(resolveInterceptorChain("tool.execute").ordered).toHaveLength(0)
    expect(diagnostics).toContain("interceptor.order.tier-conflict")
  })

  it("re-resolves after a mutation instead of serving a stale chain", () => {
    registerInterceptor(make("a"))
    expect(resolveInterceptorChain("model.request.prepare").ordered).toHaveLength(1)
    registerInterceptor(make("b"))
    expect(resolveInterceptorChain("model.request.prepare").ordered).toHaveLength(2)
    unregisterInterceptor("a")
    expect(resolveInterceptorChain("model.request.prepare").ordered).toHaveLength(1)
  })
})

describe("cleanup", () => {
  it("drops only the named surface's records", () => {
    registerInterceptor(make("hooks-one", { source: "legacy-hooks" }))
    registerInterceptor(
      make("mw-one", {
        source: "chat-middleware",
        pointId: "model.request.invoke",
        semantic: "around",
      })
    )

    expect(unregisterInterceptorsForPluginSource("p1", "legacy-hooks")).toBe(1)
    // The middleware the same activation registered survives: a hook refresh
    // must not take `ctx.chat.use` down with it.
    expect(getInterceptor("mw-one")).toBeDefined()
  })

  it("drops everything a plugin owns on unload", () => {
    registerInterceptor(make("a", { source: "legacy-hooks" }))
    registerInterceptor(make("b", { source: "interceptors" }))
    registerInterceptor(make("c", { pluginId: "p2" }))
    expect(unregisterInterceptorsForPlugin("p1")).toBe(2)
    expect(getInterceptor("c")).toBeDefined()
  })

  it("drops superseded generations so a dead activation cannot still run", () => {
    registerInterceptor(make("old", { generation: 1 }))
    registerInterceptor(make("current", { generation: 2 }))
    expect(unregisterInterceptorGeneration("p1", 2)).toBe(1)
    expect(getInterceptor("old")).toBeUndefined()
    expect(getInterceptor("current")).toBeDefined()
  })

  it("unregistering an unknown id is a no-op, not an error", () => {
    expect(unregisterInterceptor("never-registered")).toBe(false)
  })
})
