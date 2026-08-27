import { FIXTURE_END, FIXTURE_REQUEST_ID, FIXTURE_START, FIXTURE_TRACE_ID } from "../fixtures"
import type { SreLogEvidence } from "../evidence"
import {
  bucketLogs,
  createFixtureProvider,
  facetValueOf,
  filterFixtureLogs,
  groupPatterns,
} from "./fixture-provider"
import type { SreLogFilter } from "./types"

const WINDOW = { startTime: FIXTURE_START, endTime: FIXTURE_END }
const BASE: SreLogFilter = { environment: "prod", ...WINDOW }

describe("filterFixtureLogs", () => {
  it("returns the whole corpus for an unconstrained window", () => {
    expect(filterFixtureLogs(BASE)).toHaveLength(9)
  })

  it("narrows by level", () => {
    const records = filterFixtureLogs({ ...BASE, levels: ["error"] })
    expect(records.map((record) => record.id)).toEqual(["log_003"])
  })

  it("narrows by explicit evidence ids", () => {
    const records = filterFixtureLogs({ ...BASE, ids: ["log_004", "log_001", "absent"] })
    expect(records.map((record) => record.id)).toEqual(["log_001", "log_004"])
  })

  it("intersects the id filter with the rest of the filter", () => {
    expect(filterFixtureLogs({ ...BASE, ids: ["log_004"], levels: ["error"] })).toEqual([])
  })

  it("matches keywords against redacted text so secrets stay unprobeable", () => {
    expect(filterFixtureLogs({ ...BASE, keywords: ["t-001"] })).toEqual([])
    expect(filterFixtureLogs({ ...BASE, keywords: ["ak_789"] })).toEqual([])
    // The masked form is what the corpus reads as, so it is what matches.
    expect(filterFixtureLogs({ ...BASE, keywords: ["redacted"] }).length).toBeGreaterThan(0)
  })
})

describe("facetValueOf", () => {
  const record = filterFixtureLogs({ ...BASE, ids: ["log_003"] })[0]

  it("reads typed fields", () => {
    expect(facetValueOf(record, "service")).toBe("gateway")
    expect(facetValueOf(record, "level")).toBe("error")
    expect(facetValueOf(record, "event")).toBe("provider.timeout")
    expect(facetValueOf(record, "component")).toBe("provider")
  })

  it("reaches into the raw record for structured dimensions", () => {
    expect(facetValueOf(record, "provider")).toBe("qwen-vllm-a")
    expect(facetValueOf(record, "upstream_latency_ms")).toBe("45184")
  })

  it("reaches into parsed fields when raw is unstructured", () => {
    const vllm = filterFixtureLogs({ ...BASE, ids: ["log_vllm_002"] })[0]
    expect(facetValueOf(vllm, "pendingRequests")).toBe("3")
  })

  it("returns undefined for absent and non-scalar fields", () => {
    expect(facetValueOf(record, "nope")).toBeUndefined()
    const nested = { ...record, raw: { candidates: ["a"] } } as unknown as SreLogEvidence
    expect(facetValueOf(nested, "candidates")).toBeUndefined()
  })
})

describe("bucketLogs", () => {
  it("spreads records across the window and counts by level", () => {
    const buckets = bucketLogs(filterFixtureLogs(BASE), WINDOW, 4)
    expect(buckets).toHaveLength(4)
    expect(buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(9)
    expect(buckets.reduce((sum, bucket) => sum + bucket.byLevel.error, 0)).toBe(1)
  })

  it("clamps the bucket count into a drawable range", () => {
    expect(bucketLogs([], WINDOW, 0)).toHaveLength(1)
    expect(bucketLogs([], WINDOW, 10_000)).toHaveLength(240)
  })

  it("counts an unlevelled record toward the total but no level", () => {
    const record = { ...filterFixtureLogs({ ...BASE, ids: ["log_001"] })[0], level: undefined }
    const [bucket] = bucketLogs([record as SreLogEvidence], WINDOW, 1)
    expect(bucket.total).toBe(1)
    expect(bucket.byLevel).toEqual({ debug: 0, info: 0, warn: 0, error: 0 })
  })

  it("ignores records with no usable timestamp", () => {
    const record = { ...filterFixtureLogs({ ...BASE, ids: ["log_001"] })[0], time: undefined }
    const [bucket] = bucketLogs([record as SreLogEvidence], WINDOW, 1)
    expect(bucket.total).toBe(0)
  })
})

describe("groupPatterns", () => {
  const records = filterFixtureLogs(BASE)

  it("orders by count and reports no baseline when none was asked for", () => {
    const patterns = groupPatterns(records, null)
    expect(patterns[0].count).toBeGreaterThanOrEqual(patterns[patterns.length - 1].count)
    expect(patterns.every((pattern) => pattern.baselineCount === null)).toBe(true)
    expect(patterns.every((pattern) => pattern.changeRatio === null)).toBe(true)
  })

  it("leaves the bundled corpus at one template per record", () => {
    // Not a weak assertion — the fixture holds nine DISTINCT events, so there
    // is nothing to collapse. Pinned so a future fixture that does repeat an
    // event is noticed here rather than silently changing the panel's top row.
    expect(groupPatterns(records, null)).toHaveLength(records.length)
  })

  it("collapses repeats of one event into a single counted template", () => {
    const [one] = filterFixtureLogs({ ...BASE, ids: ["log_003"] })
    const repeats = [0, 1, 2].map((index) => ({
      ...one,
      id: `log_rep_${index}`,
      time: `2026-08-04T12:03:0${index}.000Z`,
    })) as SreLogEvidence[]
    const patterns = groupPatterns([one, ...repeats], null)
    expect(patterns).toHaveLength(1)
    expect(patterns[0].count).toBe(4)
    expect(patterns[0].firstSeen).toBe(one.time)
    expect(patterns[0].lastSeen).toBe("2026-08-04T12:03:02.000Z")
  })

  it("carries the evidence ids, services, levels and first/last seen of each group", () => {
    const timeout = groupPatterns(records, null).find((pattern) =>
      pattern.template.includes("provider.timeout")
    )
    expect(timeout).toMatchObject({
      count: 1,
      services: ["gateway"],
      levels: ["error"],
      evidenceIds: ["log_003"],
    })
    expect(timeout?.firstSeen).toBe(timeout?.lastSeen)
  })

  it("reports a template absent from the baseline as new, not as a ratio", () => {
    const patterns = groupPatterns(records, [])
    expect(patterns.every((pattern) => pattern.baselineCount === 0)).toBe(true)
    expect(patterns.every((pattern) => pattern.changeRatio === null)).toBe(true)
  })

  it("computes a signed ratio against a non-empty baseline", () => {
    const [one] = filterFixtureLogs({ ...BASE, ids: ["log_003"] })
    const twin = { ...one, id: "log_dup", time: "2026-08-04T12:03:00.000Z" }
    const patterns = groupPatterns([one, twin as SreLogEvidence], [one])
    expect(patterns[0]).toMatchObject({ count: 2, baselineCount: 1, changeRatio: 1 })
  })

  it("merges services and levels when one template spans several emitters", () => {
    // Reachable through TEXT logs only: a JSON template carries its service in
    // the head, so two services can never share one JSON template by design.
    const [one] = filterFixtureLogs({ ...BASE, ids: ["log_vllm_001"] })
    const other = {
      ...one,
      id: "log_vllm_alt",
      service: "edge-vllm",
      level: "error" as const,
      time: "2026-08-04T12:04:00.000Z",
    }
    const [pattern] = groupPatterns([one, other as SreLogEvidence], null)
    expect(pattern.services).toEqual(["edge-vllm", "vllm-server"])
    expect(pattern.levels).toEqual(["warn", "error"])
    expect(pattern.evidenceIds).toEqual(["log_vllm_001", "log_vllm_alt"])
  })
})

describe("createFixtureProvider", () => {
  const provider = createFixtureProvider()

  it("names itself and its bounded coverage", () => {
    expect(provider).toMatchObject({ id: "qwen-timeout-fallback", kind: "fixture" })
    expect(provider.coverage()).toEqual(WINDOW)
  })

  it("answers trace queries by trace id and by request id", async () => {
    await expect(
      provider.fetchTrace({ environment: "prod", traceId: FIXTURE_TRACE_ID })
    ).resolves.toHaveLength(5)
    await expect(
      provider.fetchTrace({ environment: "prod", requestId: FIXTURE_REQUEST_ID })
    ).resolves.toHaveLength(5)
    await expect(provider.fetchTrace({ environment: "prod", traceId: "other" })).resolves.toEqual(
      []
    )
  })

  it("windows trace spans only when both bounds are present", async () => {
    const spans = await provider.fetchTrace({
      environment: "prod",
      traceId: FIXTURE_TRACE_ID,
      startTime: "2026-08-04T12:02:54.306Z",
      endTime: FIXTURE_END,
    })
    expect(spans.map((span) => span.id)).toEqual(["span_001", "span_005"])
  })

  it("returns runbooks as ambient evidence", () => {
    expect(provider.ambientEvidence().map((entry) => entry.source)).toEqual(["runbook"])
  })

  it("caps facet values and reports the field total", async () => {
    const [service] = await provider.facets(BASE, ["service"], 1)
    expect(service.total).toBe(9)
    expect(service.values).toHaveLength(1)
    expect(service.values[0]).toEqual({ value: "gateway", count: 5 })
  })

  it("reports a facet field no record carries as empty", async () => {
    const [missing] = await provider.facets(BASE, ["nope"], 5)
    expect(missing).toEqual({ field: "nope", total: 0, values: [] })
  })

  it("describes every bundled outlet as static with no invented lag", async () => {
    const sources = await provider.sources()
    expect(sources.map((source) => source.id)).toEqual([
      "gateway-logs",
      "maas-logs",
      "vllm-logs",
      "prometheus",
    ])
    expect(sources.every((source) => source.status === "static")).toBe(true)
    expect(sources.every((source) => source.lagMs === null && source.bytes24h === null)).toBe(true)
    expect(sources.map((source) => source.recordCount)).toEqual([5, 2, 2, 3])
  })

  it("passes the baseline window through to pattern counts", async () => {
    const patterns = await provider.patterns(BASE, WINDOW)
    expect(patterns.every((pattern) => pattern.baselineCount === pattern.count)).toBe(true)
    expect(patterns.every((pattern) => pattern.changeRatio === 0)).toBe(true)
  })
})
