/** @jest-environment jsdom */

jest.mock("@/lib/db/behavior-events", () => ({ appendBehaviorEvent: jest.fn() }))
jest.mock("@cognia/redact", () => ({ hasNoLeakingPii: jest.fn(() => true) }))

import { hasNoLeakingPii } from "@cognia/redact"
import { appendBehaviorEvent } from "@/lib/db/behavior-events"
import { configureBehaviorEventExporters } from "./events/track-event"
import {
  DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
  saveBehaviorTelemetrySettings,
} from "./events/settings"
import { reportWebVital } from "./web-vitals"

const metric = {
  name: "LCP",
  id: "v5-12345",
  value: 1250,
  delta: 1250,
  rating: "good",
  navigationType: "navigate",
  route: "/performance",
  runtime: "browser",
  appVersion: "0.1.0",
}

beforeEach(() => {
  localStorage.clear()
  jest.clearAllMocks()
  jest.mocked(hasNoLeakingPii).mockReturnValue(true)
  configureBehaviorEventExporters([])
})

it("only forwards approved scalars through the existing consent and privacy gates", async () => {
  saveBehaviorTelemetrySettings({ ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS, enabled: true })
  const exportEvent = jest.fn().mockResolvedValue(undefined)
  configureBehaviorEventExporters([{ id: "test", export: exportEvent }])
  const signal = new AbortController().signal
  await expect(
    reportWebVital(
      { ...metric, entries: [{ target: "private" }], observedAt: 42 } as typeof metric,
      { signal }
    )
  ).resolves.toBe(true)
  expect(exportEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "app.web_vital",
      category: "app",
      attributes: metric,
    }),
    { signal, flushImmediately: true }
  )
  expect(appendBehaviorEvent).toHaveBeenCalledWith(
    expect.objectContaining({ attributes: metric }),
    expect.any(Object)
  )
})

it("honors master, category, sampling, destination and per-event cancellation controls", async () => {
  const signal = new AbortController().signal
  await expect(reportWebVital(metric, { signal })).resolves.toBe(false)
  for (const override of [
    { categories: { ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS.categories, app: false } },
    { sampleRate: 0 },
    { destinations: { local: false, remote: false } },
  ]) {
    saveBehaviorTelemetrySettings({
      ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
      enabled: true,
      ...override,
    })
    await expect(reportWebVital(metric, { signal })).resolves.toBe(false)
  }
  saveBehaviorTelemetrySettings({ ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS, enabled: true })
  const controller = new AbortController()
  controller.abort()
  await expect(reportWebVital(metric, { signal: controller.signal })).resolves.toBe(false)
  expect(appendBehaviorEvent).not.toHaveBeenCalled()
})

it("rejects privacy violations and non-finite metrics", async () => {
  saveBehaviorTelemetrySettings({ ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS, enabled: true })
  const signal = new AbortController().signal
  await expect(reportWebVital({ ...metric, value: Number.NaN }, { signal })).resolves.toBe(false)
  jest.mocked(hasNoLeakingPii).mockReturnValue(false)
  await expect(reportWebVital(metric, { signal })).resolves.toBe(false)
  expect(appendBehaviorEvent).not.toHaveBeenCalled()
})
