jest.mock("@cognia/logging", () => ({ loggers: { plugin: { warn: jest.fn() } } }))

import type { PluginIntentChange } from "@/lib/plugin/core/plugin-intent-events"
import type { CogsetRow, CogsetStateRow } from "@/types/plugin/plugin-cogset"

import { startCogsetWriteThrough, type CogsetWriteThroughDeps } from "./write-through"

function setup(options: {
  state?: Partial<CogsetStateRow>
  members?: CogsetRow["members"]
  reconciling?: boolean
}) {
  let intentListener: ((change: PluginIntentChange) => void) | undefined
  let configListener: ((pluginId: string, config: Record<string, unknown>) => void) | undefined
  let state: CogsetStateRow = {
    id: "host",
    alwaysOn: [],
    appliedCogsetId: "active",
    updatedAt: 0,
    ...options.state,
  }
  let cogset: CogsetRow = {
    id: "active",
    name: "Active",
    members: options.members ?? [],
    source: { kind: "manual" },
    createdAt: 0,
    updatedAt: 0,
  }
  const deps: CogsetWriteThroughDeps = {
    subscribeIntent: (listener) => {
      intentListener = listener
      return () => (intentListener = undefined)
    },
    subscribeConfig: (listener) => {
      configListener = listener
      return () => (configListener = undefined)
    },
    getState: async () => state,
    updateState: async (patch) => {
      state = { ...state, ...patch }
    },
    getCogset: async (id) => (id === cogset.id ? cogset : undefined),
    updateCogset: async (_id, patch) => {
      cogset = { ...cogset, ...patch }
    },
    getPluginManifest: async () => ({
      configSchema: { properties: { token: { type: "string", secret: true } } },
    }),
    isReconciling: () => !!options.reconciling,
  }
  const handle = startCogsetWriteThrough(deps)
  return {
    handle,
    intent: (change: PluginIntentChange) => intentListener?.(change),
    config: (pluginId: string, config: Record<string, unknown>) =>
      configListener?.(pluginId, config),
    cogset: () => cogset,
    state: () => state,
    listening: () => !!intentListener && !!configListener,
  }
}

describe("cogset write-through", () => {
  it("adds a manually enabled plugin and removes a manually disabled member", async () => {
    const t = setup({ members: [{ pluginId: "old" }] })
    t.intent({ pluginId: "new", intent: "enabled", reason: "manual" })
    t.intent({ pluginId: "old", intent: "disabled", reason: "batch" })
    await t.handle.settled()
    expect(t.cogset().members).toEqual([{ pluginId: "new" }])
  })

  it("ignores its own toggles, auto intent and always-on plugins being enabled", async () => {
    const t = setup({ state: { alwaysOn: ["core"] } })
    t.intent({ pluginId: "x", intent: "enabled", reason: "cogset" })
    t.intent({ pluginId: "y", intent: "auto", reason: "manual" })
    t.intent({ pluginId: "core", intent: "enabled", reason: "manual" })
    await t.handle.settled()
    expect(t.cogset().members).toEqual([])
  })

  it("takes a manually disabled always-on plugin out of the always-on set", async () => {
    const t = setup({ state: { alwaysOn: ["core", "other"] } })
    t.intent({ pluginId: "core", intent: "disabled", reason: "manual" })
    await t.handle.settled()
    expect(t.state().alwaysOn).toEqual(["other"])
  })

  it("stores a member's edited settings without its secrets", async () => {
    const t = setup({ members: [{ pluginId: "gh", config: { org: "old" } }, { pluginId: "pdf" }] })
    t.config("gh", { org: "acme", token: "secret" })
    t.config("not-a-member", { a: 1 })
    await t.handle.settled()
    expect(t.cogset().members).toEqual([
      { pluginId: "gh", config: { org: "acme" } },
      { pluginId: "pdf" },
    ])
  })

  it("drops a member's config when only secrets are left", async () => {
    const t = setup({ members: [{ pluginId: "gh", config: { org: "old" } }] })
    t.config("gh", { token: "secret" })
    await t.handle.settled()
    expect(t.cogset().members).toEqual([{ pluginId: "gh" }])
  })

  it("ignores config applied by an activation", async () => {
    const t = setup({ members: [{ pluginId: "gh" }], reconciling: true })
    t.config("gh", { org: "from-activation" })
    await t.handle.settled()
    expect(t.cogset().members).toEqual([{ pluginId: "gh" }])
  })

  it("does nothing without an applied cogset, and stops listening", async () => {
    const t = setup({ state: { appliedCogsetId: undefined } })
    t.intent({ pluginId: "x", intent: "enabled", reason: "manual" })
    await t.handle.settled()
    expect(t.cogset().members).toEqual([])
    t.handle.stop()
    expect(t.listening()).toBe(false)
  })
})
