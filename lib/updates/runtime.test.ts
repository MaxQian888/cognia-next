/** @jest-environment jsdom */
import {
  ASSET_KIND_GROUP,
  DEFAULT_UPDATE_CENTER_SETTINGS,
  UPDATE_ASSET_KINDS,
} from "@cognia/agent-config-types"

const settingsState: { settings: Record<string, unknown> | undefined; saved: unknown[] } = {
  settings: {},
  saved: [],
}

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: settingsState.settings,
      save: async (patch: unknown) => {
        settingsState.saved.push(patch)
        Object.assign(settingsState.settings as object, patch as object)
      },
    }),
  },
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isNativeMobile: () => false,
  isTauri: () => true,
}))
jest.mock("@/lib/logging", () => ({
  loggers: {
    app: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  },
}))

import {
  __resetUpdateCoordinator,
  getUpdateCoordinator,
  productionAdapters,
  readUpdateCenterSettings,
} from "./runtime"

beforeEach(() => {
  settingsState.settings = {}
  settingsState.saved = []
  __resetUpdateCoordinator()
})

describe("readUpdateCenterSettings", () => {
  it("merges the defaults forward for an install that never saw this feature", () => {
    expect(readUpdateCenterSettings()).toEqual(DEFAULT_UPDATE_CENTER_SETTINGS)
  })

  it("keeps a stored channel", () => {
    settingsState.settings = { updateCenter: { channel: "beta" } }
    expect(readUpdateCenterSettings().channel).toBe("beta")
    expect(readUpdateCenterSettings().notifyCritical).toBe(true)
  })
})

describe("productionAdapters", () => {
  const adapters = productionAdapters()

  it("covers every asset kind the vocabulary declares", () => {
    const kinds = new Set(adapters.map((a) => a.kind))
    for (const kind of UPDATE_ASSET_KINDS) expect([...kinds]).toContain(kind)
  })

  it("never claims an in-app install for a store-backed asset", () => {
    for (const adapter of adapters) {
      if (adapter.kind.startsWith("mobile-")) expect(adapter.executor).not.toBe("tauri")
      if (adapter.kind.startsWith("browser-")) expect(adapter.executor).toBe("browser-store")
    }
  })

  it("places every adapter in a display group", () => {
    for (const adapter of adapters) expect(ASSET_KIND_GROUP[adapter.kind]).toBeDefined()
  })
})

describe("getUpdateCoordinator", () => {
  it("is a singleton so two surfaces cannot run competing sweeps", () => {
    expect(getUpdateCoordinator()).toBe(getUpdateCoordinator())
  })

  it("persists through the settings store", async () => {
    const coordinator = getUpdateCoordinator()
    coordinator.rolloutBucket()
    await new Promise((r) => setTimeout(r, 0))
    expect(settingsState.saved.length).toBeGreaterThan(0)
    expect(readUpdateCenterSettings().rolloutBucket).toBeGreaterThanOrEqual(0)
  })

  it("keeps one stable rollout bucket across calls", () => {
    const coordinator = getUpdateCoordinator()
    const first = coordinator.rolloutBucket()
    expect(coordinator.rolloutBucket()).toBe(first)
  })
})
