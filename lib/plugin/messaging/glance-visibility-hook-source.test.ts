import { GlancePluginModuleRegistry } from "@/lib/glance/plugin-registry"
import type { PluginGlanceVisibilityEvent } from "@/types/plugin/plugin-glance"

import {
  __resetGlanceVisibilityHookSourceForTesting,
  installGlanceVisibilityHookSource,
  type GlanceVisibilityHookSourceDeps,
} from "./glance-visibility-hook-source"

jest.mock("./hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchGlanceVisibilityChange: jest.fn() }),
}))
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: { getState: () => ({ plugins: {} }), subscribe: () => () => {} },
}))

const listening = () => ({ onGlanceVisibilityChange: () => undefined })

function harness() {
  const registry = new GlancePluginModuleRegistry()
  const hooks = new Map<string, object | null>()
  const pluginListeners = new Set<() => void>()
  const sent: Array<[string, PluginGlanceVisibilityEvent]> = []
  const dispatch = jest.fn(async (pluginId: string, event: PluginGlanceVisibilityEvent) => {
    sent.push([pluginId, event])
  })
  const deps: GlanceVisibilityHookSourceDeps = {
    registry,
    hooksOf: (pluginId) => hooks.get(pluginId) ?? null,
    subscribePlugins: (listener) => {
      pluginListeners.add(listener)
      return () => pluginListeners.delete(listener)
    },
    dispatch,
  }
  const setHooks = (pluginId: string, value: object | null) => {
    hooks.set(pluginId, value)
    for (const listener of pluginListeners) listener()
  }
  return { registry, deps, sent, dispatch, setHooks, pluginListeners }
}

afterEach(() => __resetGlanceVisibilityHookSourceForTesting())

describe("installGlanceVisibilityHookSource", () => {
  it("delivers the current state once when the plugin starts listening", () => {
    const { registry, deps, sent, setHooks } = harness()
    registry.register("com.ci", { id: "builds", title: "Builds" })
    registry.register("com.ci", { id: "deploys", title: "Deploys" })
    registry.setOnScreen("panel", ["plugin:com.ci:builds"])

    installGlanceVisibilityHookSource(deps)
    // Not listening yet: the manifest modules exist before the Python hooks.
    expect(sent).toEqual([])

    setHooks("com.ci", listening())
    expect(sent).toEqual([
      ["com.ci", { moduleId: "builds", visible: true }],
      ["com.ci", { moduleId: "deploys", visible: false }],
    ])

    // An unrelated plugin-runtime change delivers nothing new.
    setHooks("com.other", null)
    expect(sent).toHaveLength(2)
  })

  it("delivers every flip, only to the module's own plugin", () => {
    const { registry, deps, sent, setHooks } = harness()
    registry.register("com.ci", { id: "builds", title: "Builds" })
    registry.register("com.other", { id: "builds", title: "Other builds" })
    setHooks("com.ci", listening())
    setHooks("com.other", listening())
    installGlanceVisibilityHookSource(deps)
    sent.length = 0

    registry.setOnScreen("panel", ["plugin:com.ci:builds"])
    expect(sent).toEqual([["com.ci", { moduleId: "builds", visible: true }]])

    registry.setOnScreen("panel", null)
    expect(sent).toEqual([
      ["com.ci", { moduleId: "builds", visible: true }],
      ["com.ci", { moduleId: "builds", visible: false }],
    ])
  })

  it("does not repeat a state for data updates", () => {
    const { registry, deps, sent, setHooks } = harness()
    registry.register("com.ci", { id: "builds", title: "Builds" })
    setHooks("com.ci", listening())
    installGlanceVisibilityHookSource(deps)
    sent.length = 0

    registry.update("com.ci", "builds", { summary: "green" })
    registry.update("com.ci", "builds", { summary: "red" })
    expect(sent).toEqual([])
  })

  it("delivers the state of a module declared later", () => {
    const { registry, deps, sent, setHooks } = harness()
    setHooks("com.ci", listening())
    installGlanceVisibilityHookSource(deps)
    registry.setOnScreen("panel", ["plugin:com.ci:late"])

    registry.register("com.ci", { id: "late", title: "Late" })
    expect(sent).toEqual([["com.ci", { moduleId: "late", visible: true }]])
  })

  it("starts over when the plugin's hooks are registered anew, and forgets a dropped plugin", () => {
    const { registry, deps, sent, setHooks } = harness()
    registry.register("com.ci", { id: "builds", title: "Builds" })
    setHooks("com.ci", listening())
    installGlanceVisibilityHookSource(deps)
    expect(sent).toHaveLength(1)

    // A reload registers a fresh hooks object: it hears the state again.
    setHooks("com.ci", listening())
    expect(sent).toHaveLength(2)

    // Disabled: no hooks, modules dropped. Re-enabled: heard again.
    setHooks("com.ci", null)
    registry.unregisterAllByPlugin("com.ci")
    registry.register("com.ci", { id: "builds", title: "Builds" })
    setHooks("com.ci", listening())
    expect(sent).toHaveLength(3)
    expect(sent[2]).toEqual(["com.ci", { moduleId: "builds", visible: false }])
  })

  it("ignores a plugin whose hooks do not include the glance hook", () => {
    const { registry, deps, sent, setHooks } = harness()
    registry.register("com.ci", { id: "builds", title: "Builds" })
    setHooks("com.ci", { onCommand: () => undefined })
    installGlanceVisibilityHookSource(deps)
    registry.setOnScreen("panel", ["plugin:com.ci:builds"])
    expect(sent).toEqual([])
  })

  it("logs instead of throwing when a delivery fails", async () => {
    const { registry, deps, dispatch, setHooks } = harness()
    dispatch.mockRejectedValueOnce(new Error("python host gone"))
    registry.register("com.ci", { id: "builds", title: "Builds" })
    installGlanceVisibilityHookSource(deps)
    expect(() => setHooks("com.ci", listening())).not.toThrow()
    await Promise.resolve()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it("shares one feed between installs and stops only when the last one is released", () => {
    const { registry, deps, sent, setHooks, pluginListeners } = harness()
    registry.register("com.ci", { id: "builds", title: "Builds" })
    setHooks("com.ci", listening())
    const first = installGlanceVisibilityHookSource(deps)
    const second = installGlanceVisibilityHookSource(deps)
    expect(sent).toHaveLength(1)
    expect(pluginListeners.size).toBe(1)

    first()
    first() // releasing twice is a no-op
    registry.setOnScreen("panel", ["plugin:com.ci:builds"])
    expect(sent).toHaveLength(2)

    second()
    expect(pluginListeners.size).toBe(0)
    registry.setOnScreen("panel", null)
    expect(sent).toHaveLength(2)
  })
})
