/**
 * The store-reading half only. `resolveEffortSurface` keeps its own matrix in
 * `components/chat/composer/effort-surface.test.ts`, and duplicating it here
 * would pin the same decisions twice. What is new is that a caller with no
 * React, which is every plugin, gets the SAME four inputs the composer's hook
 * subscribes to.
 */

const settingsState: { settings?: Record<string, unknown> } = {}
let runtimeKind: "builtin" | "external" = "builtin"

const settingsListeners = new Set<() => void>()
const runtimeListeners = new Set<() => void>()
const subscriber = (listeners: Set<() => void>) => (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const notify = (listeners: Set<() => void>) => {
  for (const listener of [...listeners]) listener()
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => settingsState,
    subscribe: (listener: () => void) => subscriber(settingsListeners)(listener),
  },
}))

jest.mock("@/stores/agent/agent-runtime-store", () => ({
  runtimeRefForSession: () => ({ kind: runtimeKind }),
  useAgentRuntimeStore: {
    subscribe: (listener: () => void) => subscriber(runtimeListeners)(listener),
  },
}))

import { effortSurfaceForSession, subscribeEffortSurface } from "./effort-surface-session"

beforeEach(() => {
  settingsState.settings = {}
  runtimeKind = "builtin"
  settingsListeners.clear()
  runtimeListeners.clear()
})

describe("effortSurfaceForSession", () => {
  /**
   * The bug this function exists to make unreachable: the model picker writes
   * `providerOverride`, and a caller reading the `provider` compat shim gets
   * `undefined`, which collapses the protocol to anthropic and empties the
   * ladder for every OpenAI-dialect model.
   */
  it("reads the provider from the field the model picker actually writes", () => {
    const surface = effortSurfaceForSession({
      id: "s1",
      model: "gpt-5",
      providerOverride: "openai",
    })

    expect(surface.providerId).toBe("openai")
    expect(surface.levels).toContain("xhigh")
    expect(surface.levels).toContain("ultracode")
  })

  /**
   * A session that pins no model is on the built-in rail with the app default,
   * not on a generic gateway. Branching on "is a model pinned" instead of the
   * lane costs the two deepest tiers on the majority of conversations.
   */
  it("falls back to the app default model rather than the external ladder", () => {
    settingsState.settings = { defaultModel: "claude-opus-5", defaultProvider: "anthropic" }

    const surface = effortSurfaceForSession({ id: "s1" })

    expect(surface.external).toBe(false)
    expect(surface.levels).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"])
  })

  /** The lane, not the presence of a model, is what selects the external ladder. */
  it("uses the external ladder when the session's lane is an external agent", () => {
    runtimeKind = "external"

    const surface = effortSurfaceForSession({
      id: "s1",
      model: "gpt-5",
      providerOverride: "openai",
    })

    expect(surface.external).toBe(true)
    expect(surface.levels).not.toContain("max")
    expect(surface.levels).not.toContain("ultracode")
  })

  /** A model that does not reason at all gets no depth control, not a full ladder. */
  it("gates on whether the model reasons", () => {
    const surface = effortSurfaceForSession({
      id: "s1",
      model: "gpt-4o",
      providerOverride: "openai",
    })

    expect(surface.levels).toEqual([])
  })

  /** Hiding a tier is a user instruction, and it reaches every control. */
  it("applies the user's hidden-tier preference", () => {
    settingsState.settings = { composerBehavior: { hiddenEffortTiers: ["max", "ultracode"] } }

    const surface = effortSurfaceForSession({ id: "s1", model: "claude-opus-5" })

    expect(surface.offered).toContain("max")
    expect(surface.levels).not.toContain("max")
    expect(surface.levels).not.toContain("ultracode")
  })

  it("answers for no session at all without throwing", () => {
    expect(effortSurfaceForSession(null).external).toBe(false)
  })
})

/**
 * The snapshot alone is a trap for a caller with no hooks. Three of the four
 * inputs live in stores, not on the session row, so a plugin that memoises the
 * ladder on the row goes on offering `max` and `ultracode` after the
 * conversation moved to a lane that cannot carry them.
 */
describe("subscribeEffortSurface", () => {
  it("fires when the lane changes even though the session row did not", () => {
    const listener = jest.fn()
    subscribeEffortSurface("s1", listener)

    runtimeKind = "external"
    notify(runtimeListeners)

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("fires when a hidden-tier preference narrows the offer", () => {
    const listener = jest.fn()
    subscribeEffortSurface("s1", listener)

    settingsState.settings = { composerBehavior: { hiddenEffortTiers: ["max"] } }
    notify(settingsListeners)

    expect(listener).toHaveBeenCalledTimes(1)
  })

  /**
   * Both stores carry far more than these four fields. Waking a dial for a
   * settings write that cannot have changed its ladder is a re-render for
   * nothing, which is why this compares a signature rather than forwarding.
   */
  it("stays quiet for a store write that cannot change the answer", () => {
    const listener = jest.fn()
    subscribeEffortSurface("s1", listener)

    settingsState.settings = { theme: "dark" }
    notify(settingsListeners)

    expect(listener).not.toHaveBeenCalled()
  })

  it("stops listening once released", () => {
    const listener = jest.fn()
    const stop = subscribeEffortSurface("s1", listener)
    stop()

    runtimeKind = "external"
    notify(runtimeListeners)

    expect(listener).not.toHaveBeenCalled()
  })
})
