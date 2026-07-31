/** @jest-environment jsdom */

import {
  BEHAVIOR_TELEMETRY_STORAGE_KEY,
  DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
  configureBehaviorTelemetrySettings,
  getBehaviorTelemetrySettings,
  isBehaviorTelemetryEnabled,
  saveBehaviorTelemetrySettings,
  setBehaviorTelemetryEnabled,
} from "./settings"

beforeEach(() => {
  configureBehaviorTelemetrySettings(null)
  localStorage.clear()
})

it("defaults behavior telemetry off and persists explicit choices", () => {
  expect(isBehaviorTelemetryEnabled()).toBe(false)
  setBehaviorTelemetryEnabled(true)
  expect(JSON.parse(localStorage.getItem(BEHAVIOR_TELEMETRY_STORAGE_KEY) ?? "{}")).toMatchObject({
    enabled: true,
  })
  expect(isBehaviorTelemetryEnabled()).toBe(true)
  setBehaviorTelemetryEnabled(false)
  expect(isBehaviorTelemetryEnabled()).toBe(false)
})

it("defaults to private local capture with every lifecycle category available", () => {
  expect(getBehaviorTelemetrySettings()).toEqual(DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS)
  expect(DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS).toMatchObject({
    enabled: false,
    destinations: { local: true, remote: false },
    categories: {
      chat: true,
      workflow: true,
      connector: true,
      agentTeam: true,
      system: true,
    },
    sampleRate: 1,
    retentionDays: 30,
    maxStoredEvents: 10_000,
  })
})

it("migrates the legacy opt-in and sanitizes persisted limits", () => {
  localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "true")
  expect(getBehaviorTelemetrySettings()).toMatchObject({
    enabled: true,
    destinations: { local: true, remote: true },
  })

  saveBehaviorTelemetrySettings({
    ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
    enabled: true,
    sampleRate: 2,
    retentionDays: -1,
    maxStoredEvents: 99_999_999,
  })
  expect(getBehaviorTelemetrySettings()).toMatchObject({
    sampleRate: 1,
    retentionDays: 1,
    maxStoredEvents: 100_000,
  })
})

it("treats legacy opt-out, malformed JSON, and invalid partial shapes as safe defaults", () => {
  localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "false")
  expect(getBehaviorTelemetrySettings()).toEqual(DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS)

  localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "{not-json")
  expect(getBehaviorTelemetrySettings()).toEqual(DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS)

  localStorage.setItem(
    BEHAVIOR_TELEMETRY_STORAGE_KEY,
    JSON.stringify({
      enabled: "yes",
      destinations: [],
      categories: { chat: false, workflow: "no" },
      sampleRate: Number.NaN,
      retentionDays: 12.6,
      maxStoredEvents: 200.4,
    })
  )
  expect(getBehaviorTelemetrySettings()).toEqual({
    ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
    categories: { ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS.categories, chat: false },
    retentionDays: 13,
    maxStoredEvents: 200,
  })
})

it("fails closed when browser storage is unavailable or throws", () => {
  const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("storage denied")
  })
  expect(getBehaviorTelemetrySettings()).toEqual(DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS)
  getItem.mockRestore()

  const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("storage denied")
  })
  expect(() => saveBehaviorTelemetrySettings(DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS)).not.toThrow()
  setItem.mockRestore()

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined })
  try {
    expect(getBehaviorTelemetrySettings()).toEqual(DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS)
    expect(() => saveBehaviorTelemetrySettings(DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS)).not.toThrow()
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor)
  }
})

it("supports a host-owned runtime configuration without localStorage", () => {
  configureBehaviorTelemetrySettings({
    ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
    enabled: true,
    destinations: { local: true, remote: false },
    categories: { ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS.categories, chat: false },
    sampleRate: 0.25,
  })

  expect(getBehaviorTelemetrySettings()).toMatchObject({
    enabled: true,
    categories: { chat: false },
    sampleRate: 0.25,
  })
  setBehaviorTelemetryEnabled(false)
  expect(getBehaviorTelemetrySettings().enabled).toBe(false)
  expect(localStorage.getItem(BEHAVIOR_TELEMETRY_STORAGE_KEY)).toContain('"enabled":false')
})
