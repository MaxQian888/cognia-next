import { getSettings } from "@/lib/db/settings"
import {
  configureBehaviorTelemetrySettings,
  DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
} from "@/lib/telemetry/events/settings"
import { __resetHeadlessRuntimesForTesting, listHeadlessRuntimes } from "../registry"

jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn() }))
const mockGetPersisted = jest.fn()
const mockUnsubscribe = jest.fn()
const mockSubscribe = jest.fn<{ unsubscribe: typeof mockUnsubscribe }, [unknown]>(() => ({
  unsubscribe: mockUnsubscribe,
}))
const mockConfigureExporters = jest.fn()
const mockLiveQuery = jest.fn((query: () => Promise<unknown>) => ({
  query,
  subscribe: (observer: unknown) => mockSubscribe(observer),
}))
jest.mock("dexie", () => ({
  liveQuery: (query: () => Promise<unknown>) => mockLiveQuery(query),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ settings: { get: (...args: unknown[]) => mockGetPersisted(...args) } }),
}))
jest.mock("@/lib/telemetry/events/settings", () => ({
  DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS: {
    enabled: false,
    destinations: { local: true, remote: false },
    categories: {
      chat: true,
      workflow: true,
      connector: true,
      agentTeam: true,
      app: true,
      system: true,
    },
    sampleRate: 1,
    retentionDays: 30,
    maxStoredEvents: 10_000,
  },
  configureBehaviorTelemetrySettings: jest.fn(),
}))
jest.mock("@/lib/telemetry/events/track-event", () => ({
  configureBehaviorEventExporters: (...args: unknown[]) => mockConfigureExporters(...args),
  createOtlpBehaviorEventExporter: (exportBody: (body: string) => Promise<void>) => ({
    id: "otlp",
    requiresRemoteConsent: true,
    export: exportBody,
  }),
}))

interface StubExporter {
  id: string
  requiresRemoteConsent?: boolean
  export: (body: string) => Promise<void>
}

/** The OTLP body sender behind the last installed exporter set. */
function otlpSender(): ((body: string) => Promise<void>) | undefined {
  const installed = mockConfigureExporters.mock.calls.at(-1)?.[0] as StubExporter[] | undefined
  return installed?.find((exporter) => exporter.id === "otlp")?.export
}

/** Ids of the last installed exporter set, in install order. */
function installedIds(): string[] {
  const installed = mockConfigureExporters.mock.calls.at(-1)?.[0] as StubExporter[] | undefined
  return (installed ?? []).map((exporter) => exporter.id)
}

const mockGetSettings = jest.mocked(getSettings)
const mockConfigure = jest.mocked(configureBehaviorTelemetrySettings)

describe("behavior telemetry headless runtime", () => {
  beforeAll(async () => {
    __resetHeadlessRuntimesForTesting()
    await import("./behavior-telemetry")
  })

  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS
    delete process.env.COGNIA_POSTHOG_HOST
    delete process.env.COGNIA_POSTHOG_PROJECT_TOKEN
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST
    delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
    delete process.env.COGNIA_OBSERVABILITY_INSTALLATION_ID
  })

  it("registers and installs the structured account policy", async () => {
    const policy = {
      ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
      enabled: true,
      sampleRate: 0.5,
    }
    mockGetSettings.mockResolvedValue({ behaviorTelemetry: policy } as never)
    mockGetPersisted.mockResolvedValue({ behaviorTelemetry: policy } as never)
    const runtime = listHeadlessRuntimes().find(({ name }) => name === "behavior-telemetry")

    expect(runtime).toMatchObject({ name: "behavior-telemetry", hosts: ["brain"] })
    const stop = await runtime!.start({} as never)
    expect(mockConfigure).toHaveBeenCalledWith(policy)
    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    await stop!()
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
    expect(mockConfigure).toHaveBeenLastCalledWith(null)
  })

  it("migrates the legacy account opt-in when no structured policy exists", async () => {
    mockGetSettings.mockResolvedValue({ telemetryEnabled: true } as never)
    mockGetPersisted.mockResolvedValue(undefined)
    const runtime = listHeadlessRuntimes().find(({ name }) => name === "behavior-telemetry")

    await runtime!.start({} as never)

    expect(mockConfigure).toHaveBeenCalledWith({
      ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
      enabled: true,
    })
  })

  it("keeps the default-off policy when no structured or legacy opt-in exists", async () => {
    mockGetSettings.mockResolvedValue({} as never)
    mockGetPersisted.mockResolvedValue(undefined)
    const runtime = listHeadlessRuntimes().find(({ name }) => name === "behavior-telemetry")

    await runtime!.start({} as never)

    expect(mockConfigure).toHaveBeenCalledWith(DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS)
  })

  it("installs an OTLP logs exporter from the standard headless environment", async () => {
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "https://collector.example/v1/logs"
    process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS =
      "authorization=Bearer%20token,invalid,x-scope=behavior"
    mockGetSettings.mockResolvedValue({ telemetryEnabled: false } as never)
    mockGetPersisted.mockResolvedValue(undefined)
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response)
    const runtime = listHeadlessRuntimes().find(({ name }) => name === "behavior-telemetry")

    const stop = await runtime!.start({} as never)
    const exporter = otlpSender()
    expect(exporter).toBeDefined()
    await exporter!("{}")

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://collector.example/v1/logs",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "x-scope": "behavior",
          "content-type": "application/json",
        },
        body: "{}",
      })
    )
    await stop!()
    expect(mockConfigureExporters).toHaveBeenLastCalledWith([])
    fetchSpy.mockRestore()
  })

  it("falls back to the general OTLP endpoint and headers while dropping malformed headers", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://collector.example/base/"
    process.env.OTEL_EXPORTER_OTLP_HEADERS =
      "authorization=Bearer%20token,bad key=value,x-crlf=bad%0Avalue,x-encoding=%E0%A4%A,x-scope=behavior"
    mockGetSettings.mockResolvedValue({} as never)
    mockGetPersisted.mockResolvedValue(undefined)
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response)
    const runtime = listHeadlessRuntimes().find(({ name }) => name === "behavior-telemetry")

    await runtime!.start({} as never)
    const exporter = otlpSender()!
    await exporter("payload")

    expect(fetchSpy).toHaveBeenCalledWith("https://collector.example/base/v1/logs", {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "x-scope": "behavior",
        "content-type": "application/json",
      },
      body: "payload",
    })
    fetchSpy.mockRestore()
  })

  it("rejects non-success OTLP responses by status only", async () => {
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "https://collector.example/v1/logs"
    mockGetSettings.mockResolvedValue({} as never)
    mockGetPersisted.mockResolvedValue(undefined)
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: false, status: 503 } as Response)
    const runtime = listHeadlessRuntimes().find(({ name }) => name === "behavior-telemetry")

    await runtime!.start({} as never)
    const exporter = otlpSender()!

    await expect(exporter("payload")).rejects.toThrow("OTLP logs export failed with 503")
    fetchSpy.mockRestore()
  })

  it("warns once when remote-only telemetry has no headless exporter", async () => {
    const policy = {
      ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
      enabled: true,
      destinations: { local: false, remote: true },
    }
    mockGetSettings.mockResolvedValue({ behaviorTelemetry: policy } as never)
    mockGetPersisted.mockResolvedValue({ behaviorTelemetry: policy } as never)
    const log = jest.fn()
    const runtime = listHeadlessRuntimes().find(({ name }) => name === "behavior-telemetry")

    await runtime!.start({ log } as never)
    const query = mockLiveQuery.mock.calls.at(-1)?.[0] as () => Promise<unknown>
    await query()
    await query()

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(
      "warn",
      "behavior telemetry remote destination requires OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"
    )
  })

  it("applies policy updates observed while the brain stays running", async () => {
    const initial = { ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS, enabled: false }
    const updated = { ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS, enabled: true, sampleRate: 0.25 }
    mockGetSettings.mockResolvedValue({ behaviorTelemetry: initial } as never)
    mockGetPersisted.mockResolvedValue({ behaviorTelemetry: initial } as never)
    const runtime = listHeadlessRuntimes().find(({ name }) => name === "behavior-telemetry")
    const log = jest.fn()
    await runtime!.start({ log } as never)

    const observer = mockSubscribe.mock.calls.at(-1)?.[0] as {
      next: (policy: typeof updated) => void
      error: (error: unknown) => void
    }
    observer.next(updated)
    observer.error(new Error("refresh denied"))
    observer.error("refresh denied again")

    expect(mockConfigure).toHaveBeenLastCalledWith(updated)
    expect(log).toHaveBeenCalledWith(
      "warn",
      "behavior telemetry settings refresh failed: refresh denied"
    )
    expect(log).toHaveBeenCalledWith(
      "warn",
      "behavior telemetry settings refresh failed: refresh denied again"
    )
  })

  describe("headless PostHog destination", () => {
    it("installs a PostHog exporter alongside OTLP when host, token and installation id are set", async () => {
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "https://collector.example/v1/logs"
      process.env.COGNIA_POSTHOG_HOST = "https://posthog.example"
      process.env.COGNIA_POSTHOG_PROJECT_TOKEN = "phc_headless"
      process.env.COGNIA_OBSERVABILITY_INSTALLATION_ID = "install-1"
      mockGetSettings.mockResolvedValue({} as never)
      mockGetPersisted.mockResolvedValue(undefined)
      const runtime = listHeadlessRuntimes().find(({ name }) => name === "behavior-telemetry")

      await runtime!.start({ log: jest.fn() } as never)

      expect(installedIds()).toEqual(["otlp", "posthog-byo"])
    })

    it("accepts the renderer's managed project variables as a fallback", async () => {
      process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com"
      process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = "phc_managed"
      process.env.COGNIA_OBSERVABILITY_INSTALLATION_ID = "install-1"
      mockGetSettings.mockResolvedValue({} as never)
      mockGetPersisted.mockResolvedValue(undefined)
      const runtime = listHeadlessRuntimes().find(({ name }) => name === "behavior-telemetry")

      await runtime!.start({ log: jest.fn() } as never)

      expect(installedIds()).toEqual(["posthog-byo"])
    })

    it("gates the brain's PostHog destination on the account-wide remote consent", async () => {
      process.env.COGNIA_POSTHOG_HOST = "https://posthog.example"
      process.env.COGNIA_POSTHOG_PROJECT_TOKEN = "phc_headless"
      process.env.COGNIA_OBSERVABILITY_INSTALLATION_ID = "install-1"
      mockGetSettings.mockResolvedValue({} as never)
      mockGetPersisted.mockResolvedValue(undefined)
      const runtime = listHeadlessRuntimes().find(({ name }) => name === "behavior-telemetry")

      await runtime!.start({ log: jest.fn() } as never)

      const installed = mockConfigureExporters.mock.calls.at(-1)?.[0] as StubExporter[]
      // There is no per-destination switch off-desktop, so an env var must never
      // be treated as the account holder's permission to send events off-device.
      expect(installed[0].requiresRemoteConsent).toBe(true)
    })

    it("refuses a PostHog destination with no stable installation id, and says why once", async () => {
      process.env.COGNIA_POSTHOG_HOST = "https://posthog.example"
      process.env.COGNIA_POSTHOG_PROJECT_TOKEN = "phc_headless"
      const policy = {
        ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
        enabled: true,
        destinations: { local: false, remote: true },
      }
      mockGetSettings.mockResolvedValue({ behaviorTelemetry: policy } as never)
      mockGetPersisted.mockResolvedValue({ behaviorTelemetry: policy } as never)
      const log = jest.fn()
      const runtime = listHeadlessRuntimes().find(({ name }) => name === "behavior-telemetry")

      await runtime!.start({ log } as never)
      const query = mockLiveQuery.mock.calls.at(-1)?.[0] as () => Promise<unknown>
      await query()

      // A per-process id would make PostHog count one install as a new person on
      // every restart, so the destination stays off rather than sending garbage.
      expect(installedIds()).toEqual([])
      const warnings = log.mock.calls.filter(([, message]) =>
        String(message).includes("COGNIA_OBSERVABILITY_INSTALLATION_ID")
      )
      expect(warnings).toHaveLength(1)
    })

    it("stays quiet about PostHog when the account never asked for remote export", async () => {
      process.env.COGNIA_POSTHOG_HOST = "https://posthog.example"
      process.env.COGNIA_POSTHOG_PROJECT_TOKEN = "phc_headless"
      mockGetSettings.mockResolvedValue({} as never)
      mockGetPersisted.mockResolvedValue(undefined)
      const log = jest.fn()
      const runtime = listHeadlessRuntimes().find(({ name }) => name === "behavior-telemetry")

      await runtime!.start({ log } as never)

      expect(log).not.toHaveBeenCalled()
    })

    it("rejects a Personal API Key the same way as an absent configuration", async () => {
      process.env.COGNIA_POSTHOG_HOST = "https://posthog.example"
      process.env.COGNIA_POSTHOG_PROJECT_TOKEN = "phx_personal_api_key"
      process.env.COGNIA_OBSERVABILITY_INSTALLATION_ID = "install-1"
      mockGetSettings.mockResolvedValue({} as never)
      mockGetPersisted.mockResolvedValue(undefined)
      const runtime = listHeadlessRuntimes().find(({ name }) => name === "behavior-telemetry")

      await runtime!.start({ log: jest.fn() } as never)

      expect(installedIds()).toEqual([])
    })
  })
})
