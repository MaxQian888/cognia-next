/** @jest-environment node */

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: { getState: jest.fn(() => ({ plugins: {} })) },
}))

import { usePluginStore } from "@/stores/plugin-runtime"
import type { PluginHooksAll } from "@/types/plugin/plugin-hooks"
import {
  registerInterceptor,
  resolveInterceptorChain,
  __resetInterceptorRegistryForTesting,
} from "@/lib/plugin/interceptors"
import {
  getPluginHookContribution,
  getPluginHookHandler,
  isPluginHooksEnabled,
  listEnabledHookPlugins,
  listHookContributors,
  listRegisteredHookPlugins,
  registerPluginHookContribution,
  unregisterPluginHookContribution,
  __resetHookRegistryForTesting,
} from "./hook-registry"

const getState = usePluginStore.getState as unknown as jest.Mock

function setPlugins(plugins: Record<string, { status: string }>) {
  getState.mockReturnValue({ plugins })
}

const hooks = (over: Partial<Record<string, unknown>> = {}): PluginHooksAll =>
  ({ onMessageSend: jest.fn(), ...over }) as unknown as PluginHooksAll

beforeEach(() => {
  __resetHookRegistryForTesting()
  setPlugins({})
})

describe("registration", () => {
  it("registers, reads back and unregisters one plugin's hooks", () => {
    registerPluginHookContribution("p1", hooks())
    expect(listRegisteredHookPlugins()).toEqual(["p1"])
    expect(getPluginHookContribution("p1")?.priority).toBe(0)

    expect(unregisterPluginHookContribution("p1")).toBe(true)
    expect(listRegisteredHookPlugins()).toEqual([])
    expect(unregisterPluginHookContribution("p1")).toBe(false)
  })

  it("re-registering the same plugin refreshes rather than duplicating", () => {
    // Hot reload and snapshot restore both re-register the same id.
    registerPluginHookContribution("p1", hooks(), 1)
    registerPluginHookContribution("p1", hooks(), 9)
    expect(listRegisteredHookPlugins()).toEqual(["p1"])
    expect(getPluginHookContribution("p1")?.priority).toBe(9)
  })
})

describe("the single liveness rule", () => {
  it("treats a plugin with no store row as live", () => {
    // Mid-activation: hooks are registered before the store row settles, and an
    // `onEnable` hook has to be able to fire for its own activation.
    registerPluginHookContribution("p1", hooks())
    expect(isPluginHooksEnabled("p1")).toBe(true)
    expect(listEnabledHookPlugins()).toEqual(["p1"])
  })

  it("excludes a disabled plugin from both listings", () => {
    // The defect this registry exists to fix: one dispatcher applied this rule
    // and the other did not, so a disabled plugin kept receiving half its hooks.
    registerPluginHookContribution("p1", hooks())
    setPlugins({ p1: { status: "disabled" } })
    expect(isPluginHooksEnabled("p1")).toBe(false)
    expect(listEnabledHookPlugins()).toEqual([])
    expect(listHookContributors("onMessageSend")).toEqual([])
  })

  it("reflects an enablement flip without re-registration", () => {
    // Enablement is READ from the store, never mirrored — a cached copy is how
    // the two stores drifted apart.
    registerPluginHookContribution("p1", hooks())
    setPlugins({ p1: { status: "disabled" } })
    expect(listEnabledHookPlugins()).toEqual([])
    setPlugins({ p1: { status: "enabled" } })
    expect(listEnabledHookPlugins()).toEqual(["p1"])
  })
})

describe("ordering", () => {
  it("sorts by priority descending, then plugin id", () => {
    registerPluginHookContribution("b", hooks(), 1)
    registerPluginHookContribution("a", hooks(), 5)
    registerPluginHookContribution("c", hooks(), 1)
    expect(listEnabledHookPlugins()).toEqual(["a", "b", "c"])
  })

  it("lists only the plugins contributing the requested hook", () => {
    registerPluginHookContribution("p1", hooks())
    registerPluginHookContribution("p2", hooks({ onMessageSend: undefined }))
    expect(listHookContributors("onMessageSend")).toEqual(["p1"])
  })
})

describe("getPluginHookHandler", () => {
  it("resolves a live plugin's handler", () => {
    const fn = jest.fn()
    registerPluginHookContribution("p1", hooks({ onPreToolUse: fn }))
    expect(getPluginHookHandler("p1", "onPreToolUse")).toBe(fn)
  })

  it("returns undefined for unknown plugin, disabled plugin, or missing hook", () => {
    // All three collapse to "nothing to run" so the settings.json `plugin`
    // handler fails open rather than blocking a turn on a stale config.
    registerPluginHookContribution("p1", hooks())
    expect(getPluginHookHandler("nope", "onMessageSend")).toBeUndefined()
    expect(getPluginHookHandler("p1", "onNotAHook")).toBeUndefined()
    setPlugins({ p1: { status: "disabled" } })
    expect(getPluginHookHandler("p1", "onMessageSend")).toBeUndefined()
  })

  it("ignores a non-function value under a hook name", () => {
    registerPluginHookContribution("p1", hooks({ onMessageSend: "not a function" }))
    expect(getPluginHookHandler("p1", "onMessageSend")).toBeUndefined()
  })
})

describe("interceptor normalization (ADR-0189)", () => {
  beforeEach(() => {
    __resetInterceptorRegistryForTesting()
  })

  it("mints an interceptor record for each interceptor-shaped hook", () => {
    setPlugins({ p1: { status: "enabled" } })
    registerPluginHookContribution(
      "p1",
      hooks({ onChatRequest: () => undefined, onPostToolUse: () => undefined })
    )

    expect(resolveInterceptorChain("model.request.prepare").ordered).toHaveLength(1)
    expect(resolveInterceptorChain("tool.result.project").ordered).toHaveLength(1)
  })

  it("does NOT normalize the guard-shaped onPreToolUse", () => {
    // Its shape is allow/deny/modify. In a transform chain a later plugin could
    // turn an earlier plugin's `deny` back into `allow`.
    setPlugins({ p1: { status: "enabled" } })
    registerPluginHookContribution("p1", hooks({ onPreToolUse: () => undefined }))
    expect(resolveInterceptorChain("tool.call.prepare").ordered).toHaveLength(0)
  })

  it("replaces rather than stacks when a plugin re-registers", () => {
    setPlugins({ p1: { status: "enabled" } })
    registerPluginHookContribution("p1", hooks({ onChatRequest: () => undefined }))
    registerPluginHookContribution("p1", hooks({ onChatRequest: () => undefined }))
    expect(resolveInterceptorChain("model.request.prepare").ordered).toHaveLength(1)
  })

  it("stops dispatching a hook the plugin dropped between reloads", () => {
    setPlugins({ p1: { status: "enabled" } })
    registerPluginHookContribution("p1", hooks({ onChatRequest: () => undefined }))
    registerPluginHookContribution("p1", hooks({ onEnable: () => undefined }))
    expect(resolveInterceptorChain("model.request.prepare").ordered).toHaveLength(0)
  })

  it("drops the records when the contribution is unregistered", () => {
    setPlugins({ p1: { status: "enabled" } })
    registerPluginHookContribution("p1", hooks({ onChatRequest: () => undefined }))
    unregisterPluginHookContribution("p1")
    expect(resolveInterceptorChain("model.request.prepare").ordered).toHaveLength(0)
  })

  it("leaves a middleware the same activation registered through ctx.chat.use", () => {
    // A hook refresh is scoped to the hook surface; a plugin-wide sweep here
    // would take `ctx.chat.use` down with it.
    setPlugins({ p1: { status: "enabled" } })
    registerInterceptor({
      registrationId: "p1:mw",
      pluginId: "p1",
      pluginInstanceId: "p1#1",
      generation: 1,
      realmId: "global",
      pointId: "model.request.invoke",
      semantic: "around",
      trustTier: "community",
      order: {},
      timeoutMs: 100,
      handler: (() => undefined) as never,
      source: "chat-middleware",
      runtime: "frontend",
    })
    registerPluginHookContribution("p1", hooks({ onChatRequest: () => undefined }))
    expect(resolveInterceptorChain("model.request.invoke").ordered).toHaveLength(1)
  })
})
