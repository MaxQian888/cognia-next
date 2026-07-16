/** @jest-environment jsdom */

jest.mock("@/lib/db/behavior-events", () => ({ appendBehaviorEvent: jest.fn() }))
jest.mock("@cognia/redact", () => ({ hasNoLeakingPii: jest.fn(() => true) }))

import { hasNoLeakingPii } from "@cognia/redact"
import { appendBehaviorEvent } from "@/lib/db/behavior-events"
import { BEHAVIOR_TELEMETRY_STORAGE_KEY } from "./settings"
import { __TESTING__, configureBehaviorEventExporter, trackEvent } from "./track-event"

beforeEach(() => {
  localStorage.clear()
  jest.clearAllMocks()
  configureBehaviorEventExporter(null)
})

it("is a real default-off switch", async () => {
  expect(
    await trackEvent("chat.message.sent", {
      sessionId: "s1",
      provider: "anthropic",
      surface: "chat",
    })
  ).toBe(false)
  expect(appendBehaviorEvent).not.toHaveBeenCalled()
})

it("stores opted-in events that do not have a session", async () => {
  localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "true")
  await trackEvent("workflow.run.started", { workflowId: "wf-1", source: "manual" })
  expect(appendBehaviorEvent).toHaveBeenCalledWith(
    expect.objectContaining({ eventName: "workflow.run.started", sessionId: undefined })
  )
})

it("stores locally and exports an OTLP LogRecord after opt-in", async () => {
  localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "true")
  const exportBody = jest.fn().mockResolvedValue(undefined)
  configureBehaviorEventExporter(exportBody)

  expect(
    await trackEvent("chat.message.sent", {
      sessionId: "s1",
      provider: "anthropic",
      surface: "chat",
    })
  ).toBe(true)
  expect(appendBehaviorEvent).toHaveBeenCalledWith(
    expect.objectContaining({ eventName: "chat.message.sent", sessionId: "s1" })
  )
  expect(exportBody).toHaveBeenCalledWith(expect.stringContaining('"event.name"'))
})

it("keeps the remote sink independent when Dexie fails", async () => {
  localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "true")
  jest.mocked(appendBehaviorEvent).mockRejectedValueOnce(new Error("dexie unavailable"))
  const exportBody = jest.fn().mockResolvedValue(undefined)
  configureBehaviorEventExporter(exportBody)

  await expect(
    trackEvent("workflow.run.started", { workflowId: "wf-1", source: "scheduled" })
  ).resolves.toBe(true)
  expect(exportBody).toHaveBeenCalledTimes(1)
})

it("keeps the local sink independent when remote export fails", async () => {
  localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "true")
  configureBehaviorEventExporter(jest.fn().mockRejectedValue(new Error("collector unavailable")))
  await expect(
    trackEvent("workflow.run.started", { workflowId: "wf-2", source: "manual" })
  ).resolves.toBe(true)
  expect(appendBehaviorEvent).toHaveBeenCalledTimes(1)
})

it("rejects attributes that fail the shared PII gate", async () => {
  localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "true")
  jest.mocked(hasNoLeakingPii).mockReturnValue(false)
  expect(
    await trackEvent("connector.message.received", { adapterId: "a1", platform: "email" })
  ).toBe(false)
  expect(appendBehaviorEvent).not.toHaveBeenCalled()
})

it("serializes boolean, numeric, and string attributes", () => {
  const body = JSON.parse(
    __TESTING__.toOtlpLogBody("telemetry.preference.changed", { enabled: true, count: 2 }, 10)
  )
  const records = body.resourceLogs[0].scopeLogs[0].logRecords
  expect(records[0].timeUnixNano).toBe("10000000")
  expect(records[0].attributes).toEqual(
    expect.arrayContaining([
      { key: "enabled", value: { boolValue: true } },
      { key: "count", value: { doubleValue: 2 } },
    ])
  )
})
