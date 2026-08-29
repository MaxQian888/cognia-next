import { parseSiteWorkerAnalytics, parseSiteWorkerLogs } from "./observability-parse"

describe("parseSiteWorkerLogs", () => {
  const event = (over: Record<string, unknown> = {}) => ({
    timestamp: 1_700_000_000_000,
    $metadata: { level: "info", message: "hello" },
    ...over,
  })

  it("reads the events list wherever the response carries it", () => {
    for (const payload of [
      { result: { events: [event()] } },
      { events: [event()] },
      { result: [event()] },
      [event()],
    ]) {
      const view = parseSiteWorkerLogs(payload)
      expect(view.unrecognized).toBe(false)
      expect(view.entries).toHaveLength(1)
    }
  })

  it("says so rather than throwing when the shape is unrecognizable", () => {
    // The console falls back to the JSON tree on this; a provider that changes
    // its response must never crash the page.
    for (const payload of [null, undefined, 42, "text", { unexpected: true }]) {
      expect(parseSiteWorkerLogs(payload)).toMatchObject({ unrecognized: true, entries: [] })
    }
  })

  it("accepts epoch seconds, epoch millis, and ISO timestamps", () => {
    const view = parseSiteWorkerLogs({
      events: [
        event({ timestamp: 1_700_000_000 }),
        event({ timestamp: 1_700_000_001_000 }),
        event({ timestamp: "2026-08-29T00:00:00.000Z" }),
      ],
    })
    expect(view.entries).toHaveLength(3)
    expect(view.entries.every((entry) => entry.timestamp > 1_600_000_000_000)).toBe(true)
  })

  it("sorts newest first", () => {
    const view = parseSiteWorkerLogs({
      events: [
        event({ timestamp: 1, $metadata: { message: "old" } }),
        event({ timestamp: 2_000_000_000_000, $metadata: { message: "new" } }),
      ],
    })
    expect(view.entries.map((entry) => entry.message)).toEqual(["new", "old"])
  })

  it("treats a recorded error as an error whatever the level field says", () => {
    // `errorsOnly` filters on `$metadata.error`; the rendered row must agree
    // with what the query selected.
    const view = parseSiteWorkerLogs({
      events: [event({ $metadata: { level: "info", error: "boom" } })],
    })
    expect(view.entries[0]).toMatchObject({ level: "error", message: "boom" })
  })

  it("counts rows it could not read rather than dropping them silently", () => {
    // Losing rows quietly would make a partial read look like a quiet period.
    const view = parseSiteWorkerLogs({ events: [event(), {}, "nonsense", { timestamp: null }] })
    expect(view.entries).toHaveLength(1)
    expect(view.unparsed).toBe(3)
  })

  it("lifts the request and response facts a table column needs", () => {
    const view = parseSiteWorkerLogs({
      events: [
        event({
          $metadata: { level: "warn", message: "slow" },
          outcome: "ok",
          request: { method: "GET", url: "https://x/api" },
          response: { status: 200 },
          wallTimeMs: 42,
        }),
      ],
    })
    expect(view.entries[0]).toMatchObject({
      level: "warn",
      outcome: "ok",
      requestMethod: "GET",
      requestUrl: "https://x/api",
      statusCode: 200,
      durationMs: 42,
    })
  })

  it("keeps the original event for the row's detail", () => {
    const raw = event()
    expect(parseSiteWorkerLogs({ events: [raw] }).entries[0]?.raw).toBe(raw)
  })
})

describe("parseSiteWorkerAnalytics", () => {
  const workerPayload = (groups: unknown[]) => ({
    data: { viewer: { accounts: [{ workersInvocationsAdaptive: groups }] } },
  })
  const group = (date: string, requests: number, errors = 0) => ({
    sum: { requests, errors, subrequests: 1 },
    dimensions: { date },
  })

  it("reads the bare worker payload", () => {
    const view = parseSiteWorkerAnalytics(workerPayload([group("2026-08-01", 10, 1)]))
    expect(view.unrecognized).toBe(false)
    expect(view.worker.points).toEqual([
      { date: "2026-08-01", requests: 10, errors: 1, subrequests: 1 },
    ])
    expect(view.web).toBeUndefined()
  })

  it("reads the [worker, zone] pair the query returns with a zone and a hostname", () => {
    // The single most likely drift: the same method returns two different
    // shapes depending on whether both were available.
    const view = parseSiteWorkerAnalytics([
      workerPayload([group("2026-08-01", 10)]),
      {
        data: {
          viewer: {
            zones: [
              {
                httpRequestsAdaptiveGroups: [
                  {
                    sum: { requests: 8, pageViews: 5, bytes: 100 },
                    uniq: { uniques: 3 },
                    dimensions: { date: "2026-08-01" },
                  },
                ],
              },
            ],
          },
        },
      },
    ])
    expect(view.worker.points).toHaveLength(1)
    expect(view.web?.points[0]).toEqual({
      date: "2026-08-01",
      requests: 8,
      pageViews: 5,
      bytes: 100,
      uniques: 3,
    })
  })

  it("totals every metric across the window", () => {
    const view = parseSiteWorkerAnalytics(
      workerPayload([group("2026-08-01", 10, 1), group("2026-08-02", 5, 2)])
    )
    expect(view.worker.totals).toMatchObject({ requests: 15, errors: 3, subrequests: 2 })
  })

  it("orders points by date whatever order they arrive in", () => {
    const view = parseSiteWorkerAnalytics(
      workerPayload([group("2026-08-02", 1), group("2026-08-01", 2)])
    )
    expect(view.worker.points.map((point) => point.date)).toEqual(["2026-08-01", "2026-08-02"])
  })

  it("accepts an hourly dimension as well as a daily one", () => {
    const view = parseSiteWorkerAnalytics(
      workerPayload([
        { sum: { requests: 1 }, dimensions: { datetimeHour: "2026-08-01T05:00:00Z" } },
      ])
    )
    expect(view.worker.points[0]?.date).toBe("2026-08-01T05:00:00Z")
  })

  it("surfaces GraphQL errors that arrive alongside partial data", () => {
    const view = parseSiteWorkerAnalytics({
      ...workerPayload([group("2026-08-01", 1)]),
      errors: [{ message: "rate limited" }],
    })
    expect(view.providerErrors).toEqual(["rate limited"])
    expect(view.unrecognized).toBe(false)
  })

  it("says so rather than throwing when the shape is unrecognizable", () => {
    for (const payload of [null, 42, "text", { nope: true }]) {
      expect(parseSiteWorkerAnalytics(payload).unrecognized).toBe(true)
    }
  })

  it("is not unrecognizable merely because the window is empty", () => {
    // A Site with no traffic yet has a valid, empty answer.
    expect(parseSiteWorkerAnalytics(workerPayload([])).unrecognized).toBe(false)
  })

  it("skips a group with no usable date instead of inventing one", () => {
    const view = parseSiteWorkerAnalytics(workerPayload([{ sum: { requests: 5 } }]))
    expect(view.worker.points).toEqual([])
    expect(view.worker.totals.requests).toBe(0)
  })
})
