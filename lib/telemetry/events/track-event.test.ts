/** @jest-environment jsdom */

jest.mock("@/lib/db/behavior-events", () => ({ appendBehaviorEvent: jest.fn() }))
jest.mock("@cognia/redact", () => ({ hasNoLeakingPii: jest.fn(() => true) }))

import { hasNoLeakingPii } from "@cognia/redact"
import { appendBehaviorEvent } from "@/lib/db/behavior-events"
import {
  BEHAVIOR_TELEMETRY_STORAGE_KEY,
  DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
  saveBehaviorTelemetrySettings,
} from "./settings"
import {
  __TESTING__,
  configureBehaviorEventExporters,
  createOtlpBehaviorEventExporter,
  trackEvent,
} from "./track-event"

beforeEach(() => {
  localStorage.clear()
  jest.clearAllMocks()
  jest.mocked(hasNoLeakingPii).mockReturnValue(true)
  configureBehaviorEventExporters([])
})

it("fans one sanitized envelope out to independently configured remote destinations", async () => {
  localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "true")
  const managed = jest.fn().mockResolvedValue(undefined)
  const byo = jest.fn().mockResolvedValue(undefined)
  configureBehaviorEventExporters([
    { id: "posthog-managed", export: managed },
    { id: "posthog-byo", export: byo },
  ])

  await expect(
    trackEvent("chat.message.sent", {
      sessionId: "session-1",
      provider: "anthropic",
      surface: "chat",
    })
  ).resolves.toBe(true)

  const expected = expect.objectContaining({
    name: "chat.message.sent",
    category: "chat",
    at: expect.any(Number),
    attributes: {
      sessionId: "session-1",
      provider: "anthropic",
      surface: "chat",
    },
  })
  expect(managed).toHaveBeenCalledWith(expected)
  expect(byo).toHaveBeenCalledWith(expected)
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
  await trackEvent("workflow.run.started", { runId: "run-1", trigger: "trigger.manual" })
  expect(appendBehaviorEvent).toHaveBeenCalledWith(
    expect.objectContaining({ eventName: "workflow.run.started", sessionId: undefined }),
    { maxEntries: 10_000, maxAgeDays: 30 }
  )
})

it("stores locally and exports an OTLP LogRecord after opt-in", async () => {
  localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "true")
  const exportBody = jest.fn().mockResolvedValue(undefined)
  configureBehaviorEventExporters([createOtlpBehaviorEventExporter(exportBody)])

  expect(
    await trackEvent("chat.message.sent", {
      sessionId: "s1",
      provider: "anthropic",
      surface: "chat",
    })
  ).toBe(true)
  expect(appendBehaviorEvent).toHaveBeenCalledWith(
    expect.objectContaining({ eventName: "chat.message.sent", sessionId: "s1" }),
    { maxEntries: 10_000, maxAgeDays: 30 }
  )
  expect(exportBody).toHaveBeenCalledWith(expect.stringContaining('"event.name"'))
})

it("keeps the remote sink independent when Dexie fails", async () => {
  localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "true")
  jest.mocked(appendBehaviorEvent).mockRejectedValueOnce(new Error("dexie unavailable"))
  const exportBody = jest.fn().mockResolvedValue(undefined)
  configureBehaviorEventExporters([createOtlpBehaviorEventExporter(exportBody)])

  await expect(
    trackEvent("workflow.run.started", { runId: "run-1", trigger: "trigger.schedule" })
  ).resolves.toBe(true)
  expect(exportBody).toHaveBeenCalledTimes(1)
})

it("keeps the local sink independent when remote export fails", async () => {
  localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "true")
  configureBehaviorEventExporters([
    createOtlpBehaviorEventExporter(
      jest.fn().mockRejectedValue(new Error("collector unavailable"))
    ),
  ])
  await expect(
    trackEvent("workflow.run.started", { runId: "run-2", trigger: "trigger.manual" })
  ).resolves.toBe(true)
  expect(appendBehaviorEvent).toHaveBeenCalledTimes(1)
})

it("routes eligible events only to the independently enabled destinations", async () => {
  saveBehaviorTelemetrySettings({
    ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
    enabled: true,
    destinations: { local: false, remote: true },
  })
  const exportBody = jest.fn().mockResolvedValue(undefined)
  configureBehaviorEventExporters([createOtlpBehaviorEventExporter(exportBody)])

  await expect(
    trackEvent("connector.message.received", { adapterId: "a1", platform: "lark" })
  ).resolves.toBe(true)
  expect(appendBehaviorEvent).not.toHaveBeenCalled()
  expect(exportBody).toHaveBeenCalledTimes(1)
})

it("honors category consent and sampling before touching either destination", async () => {
  saveBehaviorTelemetrySettings({
    ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
    enabled: true,
    categories: { ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS.categories, connector: false },
  })
  configureBehaviorEventExporters([
    createOtlpBehaviorEventExporter(jest.fn().mockResolvedValue(undefined)),
  ])

  await expect(
    trackEvent("connector.message.received", { adapterId: "a1", platform: "lark" })
  ).resolves.toBe(false)
  expect(appendBehaviorEvent).not.toHaveBeenCalled()

  saveBehaviorTelemetrySettings({
    ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
    enabled: true,
    sampleRate: 0,
  })
  await expect(
    trackEvent("chat.message.sent", {
      sessionId: "s1",
      provider: "anthropic",
      surface: "chat",
    })
  ).resolves.toBe(false)
  expect(appendBehaviorEvent).not.toHaveBeenCalled()
})

it("samples fractional rates deterministically", async () => {
  saveBehaviorTelemetrySettings({
    ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
    enabled: true,
    sampleRate: 0.5,
  })
  const random = jest.spyOn(Math, "random")
  random.mockReturnValueOnce(0.49).mockReturnValueOnce(0.5)

  await expect(
    trackEvent("chat.message.sent", {
      sessionId: "accepted",
      provider: "anthropic",
      surface: "chat",
    })
  ).resolves.toBe(true)
  await expect(
    trackEvent("chat.message.sent", {
      sessionId: "rejected",
      provider: "anthropic",
      surface: "chat",
    })
  ).resolves.toBe(false)
  expect(appendBehaviorEvent).toHaveBeenCalledTimes(1)
  random.mockRestore()
})

it("returns false when no destination accepts the event", async () => {
  saveBehaviorTelemetrySettings({
    ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
    enabled: true,
    destinations: { local: false, remote: false },
  })
  await expect(
    trackEvent("workflow.run.started", { runId: "run-none", trigger: "manual" })
  ).resolves.toBe(false)

  saveBehaviorTelemetrySettings({
    ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
    enabled: true,
    destinations: { local: true, remote: true },
  })
  jest.mocked(appendBehaviorEvent).mockRejectedValueOnce(new Error("dexie unavailable"))
  configureBehaviorEventExporters([
    createOtlpBehaviorEventExporter(
      jest.fn().mockRejectedValue(new Error("collector unavailable"))
    ),
  ])
  await expect(
    trackEvent("workflow.run.started", { runId: "run-rejected", trigger: "manual" })
  ).resolves.toBe(false)
})

it("rejects attributes that fail the shared PII gate", async () => {
  localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "true")
  jest.mocked(hasNoLeakingPii).mockReturnValue(false)
  expect(
    await trackEvent("connector.message.received", { adapterId: "a1", platform: "email" })
  ).toBe(false)
  expect(appendBehaviorEvent).not.toHaveBeenCalled()
})

it("rejects malformed runtime attributes before persistence or export", async () => {
  localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, "true")
  const exportBody = jest.fn().mockResolvedValue(undefined)
  configureBehaviorEventExporters([createOtlpBehaviorEventExporter(exportBody)])

  await expect(
    trackEvent("workflow.run.completed", {
      runId: "run-1",
      durationMs: Number.NaN,
    })
  ).resolves.toBe(false)
  await expect(
    trackEvent("connector.message.received", {
      adapterId: "a1",
      platform: { unsafe: true },
    } as never)
  ).resolves.toBe(false)
  await expect(
    trackEvent("workflow.run.completed", {
      runId: "x".repeat(513),
      durationMs: 1,
    })
  ).resolves.toBe(false)
  await expect(
    trackEvent("workflow.run.completed", {
      runId: "run-1",
      durationMs: 1,
      ["1invalid"]: true,
    } as never)
  ).resolves.toBe(false)
  await expect(trackEvent("workflow.run.completed", null as never)).resolves.toBe(false)
  await expect(trackEvent("workflow.run.completed", "invalid" as never)).resolves.toBe(false)
  await expect(trackEvent("workflow.run.completed", [] as never)).resolves.toBe(false)
  await expect(
    trackEvent(
      "workflow.run.completed",
      Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key${index}`, index])) as never
    )
  ).resolves.toBe(false)
  await expect(
    (trackEvent as (name: string, attributes: Record<string, unknown>) => Promise<boolean>)(
      "unknown.runtime.event",
      {}
    )
  ).resolves.toBe(false)
  expect(appendBehaviorEvent).not.toHaveBeenCalled()
  expect(exportBody).not.toHaveBeenCalled()
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

it("closes only the exporters that a reconfigure actually removes", () => {
  const closeRetained = jest.fn()
  const closeRemoved = jest.fn()
  const retained = { id: "posthog-managed", export: jest.fn(), close: closeRetained }
  const removed = { id: "posthog-byo", export: jest.fn(), close: closeRemoved }

  configureBehaviorEventExporters([retained, removed])
  configureBehaviorEventExporters([retained])

  expect(closeRemoved).toHaveBeenCalledTimes(1)
  expect(closeRetained).not.toHaveBeenCalled()

  configureBehaviorEventExporters([])
  expect(closeRetained).toHaveBeenCalledTimes(1)
})
