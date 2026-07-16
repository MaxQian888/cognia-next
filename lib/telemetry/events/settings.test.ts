/** @jest-environment jsdom */

import {
  BEHAVIOR_TELEMETRY_STORAGE_KEY,
  isBehaviorTelemetryEnabled,
  setBehaviorTelemetryEnabled,
} from "./settings"

beforeEach(() => localStorage.clear())

it("defaults behavior telemetry off and persists explicit choices", () => {
  expect(isBehaviorTelemetryEnabled()).toBe(false)
  setBehaviorTelemetryEnabled(true)
  expect(localStorage.getItem(BEHAVIOR_TELEMETRY_STORAGE_KEY)).toBe("true")
  expect(isBehaviorTelemetryEnabled()).toBe(true)
  setBehaviorTelemetryEnabled(false)
  expect(isBehaviorTelemetryEnabled()).toBe(false)
})
