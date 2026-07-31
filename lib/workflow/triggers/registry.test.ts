/**
 * @jest-environment jsdom
 *
 * Unit tests for the plugin trigger registry. Two surfaces exercised here:
 *   1. Registration + lookup + listener fan-out (queueMicrotask flush) and
 *      teardown semantics (instance.stop() + registration delete).
 *   2. Per-(plugin, kind, workflow) mute flags, including localStorage
 *      hydration / persistence and listener notification.
 *
 * The bridge layer (`lib/plugin/bridge/plugin-trigger-dispatch.ts`) covers integration
 * paths; this file is intentionally narrow so a behaviour regression in the
 * registry itself surfaces here, not in the bridge spec.
 */

import {
  __resetTriggerMutesForTesting,
  __resetTriggerRegistryForTesting,
  getPluginTrigger,
  isTriggerMuted,
  listPluginTriggers,
  registerPluginTrigger,
  setTriggerMuted,
  startPluginTriggerInstance,
  subscribePluginTriggerRegistry,
  subscribeTriggerMuteChanges,
  unregisterPluginTrigger,
  type TriggerRegistration,
} from "./registry"
import type { PluginTriggerDef, PluginTriggerStartContext } from "@/types/plugin/plugin-workflow"

function makeDef(overrides: Partial<PluginTriggerDef> = {}): PluginTriggerDef {
  return {
    kind: "trigger.bar",
    typeVersion: 1,
    label: "Bar",
    description: "",
    start: jest.fn().mockResolvedValue({ stop: jest.fn().mockResolvedValue(undefined) }),
    ...overrides,
  } as unknown as PluginTriggerDef
}

function makeRegistration(overrides: Partial<TriggerRegistration> = {}): TriggerRegistration {
  return {
    kind: "trigger.foo.bar",
    typeVersion: 1,
    pluginId: "foo",
    def: makeDef(),
    instances: new Map(),
    ...overrides,
  }
}

const startCtx: PluginTriggerStartContext = {
  workflowId: "wf-1",
  triggerId: "root-1",
  params: {},
} as unknown as PluginTriggerStartContext

beforeEach(() => {
  __resetTriggerRegistryForTesting()
  __resetTriggerMutesForTesting()
  if (typeof window !== "undefined") window.localStorage.clear()
})

describe("registerPluginTrigger / getPluginTrigger / listPluginTriggers", () => {
  it("stores a registration keyed by (kind, typeVersion)", () => {
    const reg = makeRegistration()
    registerPluginTrigger(reg)
    expect(getPluginTrigger("trigger.foo.bar", 1)).toBe(reg)
    expect(listPluginTriggers()).toEqual([reg])
  })

  it("treats different versions of the same kind as separate entries", () => {
    const v1 = makeRegistration({ typeVersion: 1 })
    const v2 = makeRegistration({ typeVersion: 2 })
    registerPluginTrigger(v1)
    registerPluginTrigger(v2)
    expect(getPluginTrigger("trigger.foo.bar", 1)).toBe(v1)
    expect(getPluginTrigger("trigger.foo.bar", 2)).toBe(v2)
    expect(listPluginTriggers()).toHaveLength(2)
  })

  it("returns undefined for unknown (kind, version)", () => {
    expect(getPluginTrigger("trigger.does.not.exist", 1)).toBeUndefined()
  })

  it("fans out register events to subscribers asynchronously", async () => {
    const listener = jest.fn()
    const unsubscribe = subscribePluginTriggerRegistry(listener)
    try {
      registerPluginTrigger(makeRegistration())
      // queueMicrotask schedules the dispatch; listeners haven't fired yet.
      expect(listener).not.toHaveBeenCalled()
      await Promise.resolve()
      expect(listener).toHaveBeenCalledWith({
        type: "register",
        kind: "trigger.foo.bar",
        typeVersion: 1,
        pluginId: "foo",
      })
    } finally {
      unsubscribe()
    }
  })

  it("stops calling unsubscribed listeners", async () => {
    const listener = jest.fn()
    const unsubscribe = subscribePluginTriggerRegistry(listener)
    unsubscribe()
    registerPluginTrigger(makeRegistration())
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
  })

  it("isolates listener errors so other subscribers still fire", async () => {
    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    const throwing = jest.fn(() => {
      throw new Error("boom")
    })
    const healthy = jest.fn()
    const off1 = subscribePluginTriggerRegistry(throwing)
    const off2 = subscribePluginTriggerRegistry(healthy)
    try {
      registerPluginTrigger(makeRegistration())
      await Promise.resolve()
      expect(throwing).toHaveBeenCalled()
      expect(healthy).toHaveBeenCalled()
      expect(consoleWarnSpy).toHaveBeenCalled()
    } finally {
      off1()
      off2()
      consoleWarnSpy.mockRestore()
    }
  })
})

describe("unregisterPluginTrigger", () => {
  it("stops live instances, clears the map, and emits an unregister event", async () => {
    const stop = jest.fn().mockResolvedValue(undefined)
    const reg = makeRegistration()
    reg.instances.set("wf-a::root-a", {
      kind: reg.kind,
      workflowId: "wf-a",
      triggerId: "root-a",
      paramsSignature: "{}",
      stop,
    })
    reg.instances.set("wf-b", {
      kind: reg.kind,
      workflowId: "wf-b",
      triggerId: "root-b",
      paramsSignature: "{}",
      stop: jest.fn().mockResolvedValue(undefined),
    })
    registerPluginTrigger(reg)
    const listener = jest.fn()
    const unsubscribe = subscribePluginTriggerRegistry(listener)
    try {
      await unregisterPluginTrigger("trigger.foo.bar", 1)
      expect(stop).toHaveBeenCalled()
      expect(getPluginTrigger("trigger.foo.bar", 1)).toBeUndefined()
      await Promise.resolve()
      expect(listener).toHaveBeenCalledWith({
        type: "unregister",
        kind: "trigger.foo.bar",
        typeVersion: 1,
        pluginId: "foo",
      })
    } finally {
      unsubscribe()
    }
  })

  it("is a no-op (and does not throw) for unknown registrations", async () => {
    await expect(unregisterPluginTrigger("trigger.does.not.exist", 99)).resolves.toBeUndefined()
  })

  it("isolates instance.stop() failures so the registration is still cleared", async () => {
    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    const reg = makeRegistration()
    reg.instances.set("wf-a", {
      kind: reg.kind,
      workflowId: "wf-a",
      triggerId: "root-a",
      paramsSignature: "{}",
      stop: jest.fn().mockRejectedValue(new Error("teardown failed")),
    })
    const otherStop = jest.fn().mockResolvedValue(undefined)
    reg.instances.set("wf-b", {
      kind: reg.kind,
      workflowId: "wf-b",
      triggerId: "root-b",
      paramsSignature: "{}",
      stop: otherStop,
    })
    registerPluginTrigger(reg)

    await unregisterPluginTrigger("trigger.foo.bar", 1)

    expect(otherStop).toHaveBeenCalled()
    expect(getPluginTrigger("trigger.foo.bar", 1)).toBeUndefined()
    expect(consoleWarnSpy).toHaveBeenCalled()
    consoleWarnSpy.mockRestore()
  })
})

describe("startPluginTriggerInstance", () => {
  it("returns undefined when the registration does not exist", async () => {
    await expect(
      startPluginTriggerInstance("trigger.unknown", 1, startCtx)
    ).resolves.toBeUndefined()
  })

  it("calls def.start, wraps the handle, and tracks it on the registration", async () => {
    const stop = jest.fn().mockResolvedValue(undefined)
    const startSpy = jest.fn().mockResolvedValue({ stop })
    const reg = makeRegistration({ def: makeDef({ start: startSpy }) })
    registerPluginTrigger(reg)

    const handle = await startPluginTriggerInstance("trigger.foo.bar", 1, startCtx)

    expect(startSpy).toHaveBeenCalledWith(startCtx)
    expect(handle).toBeDefined()
    expect(handle?.kind).toBe("trigger.foo.bar")
    expect(handle?.workflowId).toBe("wf-1")
    expect(reg.instances.get("wf-1::root-1")).toBe(handle)
    expect(handle?.triggerId).toBe("root-1")
    await handle?.stop()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(reg.instances.size).toBe(0)
  })

  it("keeps only the newest handle when the same exact binding starts concurrently", async () => {
    const resolvers: Array<(handle: { stop: jest.Mock }) => void> = []
    const startSpy = jest.fn(
      () =>
        new Promise<{ stop: jest.Mock }>((resolve) => {
          resolvers.push(resolve)
        })
    )
    const reg = makeRegistration({ def: makeDef({ start: startSpy }) })
    registerPluginTrigger(reg)
    const first = startPluginTriggerInstance("trigger.foo.bar", 1, startCtx)
    const second = startPluginTriggerInstance("trigger.foo.bar", 1, startCtx)
    await Promise.resolve()
    const firstStop = jest.fn(async () => undefined)
    const secondStop = jest.fn(async () => undefined)

    resolvers[0]({ stop: firstStop })
    await expect(first).resolves.toBeUndefined()
    resolvers[1]({ stop: secondStop })
    const live = await second

    expect(firstStop).toHaveBeenCalledTimes(1)
    expect(secondStop).not.toHaveBeenCalled()
    expect(reg.instances.get("wf-1::root-1")).toBe(live)
  })

  it("stops an in-flight source when its registration is removed", async () => {
    let resolveStart!: (handle: { stop: jest.Mock }) => void
    const startSpy = jest.fn(
      () =>
        new Promise<{ stop: jest.Mock }>((resolve) => {
          resolveStart = resolve
        })
    )
    registerPluginTrigger(makeRegistration({ def: makeDef({ start: startSpy }) }))
    const pending = startPluginTriggerInstance("trigger.foo.bar", 1, startCtx)
    await Promise.resolve()
    await unregisterPluginTrigger("trigger.foo.bar", 1)
    const stop = jest.fn(async () => undefined)

    resolveStart({ stop })

    await expect(pending).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe("mute helpers", () => {
  it("setTriggerMuted toggles, persists to localStorage, and notifies listeners", () => {
    const listener = jest.fn()
    const off = subscribeTriggerMuteChanges(listener)
    try {
      expect(isTriggerMuted("p1", "trigger.x", "wf-a")).toBe(false)
      setTriggerMuted("p1", "trigger.x", "wf-a", true)
      expect(isTriggerMuted("p1", "trigger.x", "wf-a")).toBe(true)
      expect(listener).toHaveBeenCalledTimes(1)
      const stored = JSON.parse(window.localStorage.getItem("cognia.plugin.trigger.mute")!)
      expect(stored).toContain("p1::trigger.x::wf-a")
    } finally {
      off()
    }
  })

  it("setTriggerMuted is idempotent for repeat values (no extra notify, no extra persist)", () => {
    const listener = jest.fn()
    const off = subscribeTriggerMuteChanges(listener)
    try {
      setTriggerMuted("p1", "trigger.x", "wf-a", true)
      setTriggerMuted("p1", "trigger.x", "wf-a", true)
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      off()
    }
  })

  it("setTriggerMuted false removes the key and persists the empty set", () => {
    setTriggerMuted("p1", "trigger.x", "wf-a", true)
    setTriggerMuted("p1", "trigger.x", "wf-a", false)
    expect(isTriggerMuted("p1", "trigger.x", "wf-a")).toBe(false)
    const stored = JSON.parse(window.localStorage.getItem("cognia.plugin.trigger.mute")!)
    expect(stored).toEqual([])
  })

  // The hydration path is gated by an internal `muteHydrated` flag; the
  // `__resetTriggerMutesForTesting` helper deliberately leaves it set to true
  // to keep the module deterministic across tests. To exercise the lazy load
  // we re-import via `jest.isolateModules`, which gives us a fresh module
  // instance with `muteHydrated = false`.
  it("hydrates the mute set from localStorage on first access (fresh module)", () => {
    window.localStorage.setItem(
      "cognia.plugin.trigger.mute",
      JSON.stringify(["p1::trigger.x::wf-a", "p2::trigger.y::wf-b"])
    )
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./registry") as typeof import("./registry")
      expect(mod.isTriggerMuted("p1", "trigger.x", "wf-a")).toBe(true)
      expect(mod.isTriggerMuted("p2", "trigger.y", "wf-b")).toBe(true)
      expect(mod.isTriggerMuted("p3", "trigger.z", "wf-c")).toBe(false)
    })
  })

  it("treats a missing localStorage entry as an empty mute set (fresh module)", () => {
    window.localStorage.removeItem("cognia.plugin.trigger.mute")
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./registry") as typeof import("./registry")
      expect(mod.isTriggerMuted("p1", "trigger.x", "wf-a")).toBe(false)
    })
  })

  it("ignores a non-array JSON value in localStorage during hydration (fresh module)", () => {
    window.localStorage.setItem("cognia.plugin.trigger.mute", JSON.stringify({ not: "array" }))
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./registry") as typeof import("./registry")
      expect(mod.isTriggerMuted("p1", "trigger.x", "wf-a")).toBe(false)
    })
  })

  it("tolerates corrupt JSON in localStorage during hydration (fresh module)", () => {
    window.localStorage.setItem("cognia.plugin.trigger.mute", "{not-json}")
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./registry") as typeof import("./registry")
      expect(() => mod.isTriggerMuted("p1", "trigger.x", "wf-a")).not.toThrow()
      expect(mod.isTriggerMuted("p1", "trigger.x", "wf-a")).toBe(false)
    })
  })

  it("skips non-string entries in the persisted array during hydration (fresh module)", () => {
    window.localStorage.setItem(
      "cognia.plugin.trigger.mute",
      JSON.stringify(["p1::trigger.x::wf-a", 42, null, "p2::trigger.y::wf-b"])
    )
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./registry") as typeof import("./registry")
      expect(mod.isTriggerMuted("p1", "trigger.x", "wf-a")).toBe(true)
      expect(mod.isTriggerMuted("p2", "trigger.y", "wf-b")).toBe(true)
    })
  })

  it("isolates mute listener errors so other listeners still fire", () => {
    const throwing = jest.fn(() => {
      throw new Error("boom")
    })
    const healthy = jest.fn()
    const off1 = subscribeTriggerMuteChanges(throwing)
    const off2 = subscribeTriggerMuteChanges(healthy)
    try {
      setTriggerMuted("p1", "trigger.x", "wf-a", true)
      expect(throwing).toHaveBeenCalled()
      expect(healthy).toHaveBeenCalled()
    } finally {
      off1()
      off2()
    }
  })

  it("subscribeTriggerMuteChanges returns an unsubscribe that stops further notifications", () => {
    const listener = jest.fn()
    const off = subscribeTriggerMuteChanges(listener)
    off()
    setTriggerMuted("p1", "trigger.x", "wf-a", true)
    expect(listener).not.toHaveBeenCalled()
  })

  it("swallows localStorage.setItem failures (e.g. quota errors) during persist", () => {
    const setItemSpy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    try {
      // In-memory state still flips; persistence is best-effort.
      expect(() => setTriggerMuted("p1", "trigger.x", "wf-a", true)).not.toThrow()
      expect(isTriggerMuted("p1", "trigger.x", "wf-a")).toBe(true)
    } finally {
      setItemSpy.mockRestore()
    }
  })

  it("swallows localStorage.removeItem failures during reset", () => {
    setTriggerMuted("p1", "trigger.x", "wf-a", true)
    const removeItemSpy = jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage disabled")
    })
    try {
      expect(() => __resetTriggerMutesForTesting()).not.toThrow()
      // In-memory state is still cleared even if the storage cleanup throws.
      expect(isTriggerMuted("p1", "trigger.x", "wf-a")).toBe(false)
    } finally {
      removeItemSpy.mockRestore()
    }
  })
})
