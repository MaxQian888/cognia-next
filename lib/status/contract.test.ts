import {
  CHECK_IDS,
  COMPONENT_DEPENDENCY,
  COMPONENT_IDS,
  COMPONENT_LATENCY_PHASE,
  LATENCY_BUCKET_BOUNDS_MS,
  LATENCY_BUCKET_COUNT,
  PROFILE_FRESH_MS,
  RANGE_SPECS,
  REFERENCE_FRESH_MS,
  SNAPSHOT_STALE_MS,
  STATUS_SCHEMA_VERSION,
} from "./contract"

describe("status contract v1 constants", () => {
  it("freezes the schema version and component identifiers", () => {
    expect(STATUS_SCHEMA_VERSION).toBe(1)
    expect(COMPONENT_IDS).toEqual(["signalingHttp", "signalingAuth", "relayData"])
    expect(CHECK_IDS).toEqual([...COMPONENT_IDS, "statusPage", "statusApi"])
  })

  it("models data as depending on authentication only", () => {
    expect(COMPONENT_DEPENDENCY).toEqual({
      signalingHttp: null,
      signalingAuth: null,
      relayData: "signalingAuth",
    })
    expect(Object.keys(COMPONENT_LATENCY_PHASE)).toEqual([...COMPONENT_IDS])
  })

  it("publishes freshness thresholds from the plan", () => {
    expect(REFERENCE_FRESH_MS).toBe(180_000)
    expect(PROFILE_FRESH_MS).toBe(900_000)
    expect(SNAPSHOT_STALE_MS).toBe(180_000)
  })

  it("keeps latency bounds strictly increasing with one open bucket", () => {
    const bounds = [...LATENCY_BUCKET_BOUNDS_MS]
    expect(bounds).toEqual([...bounds].sort((left, right) => left - right))
    expect(new Set(bounds).size).toBe(bounds.length)
    expect(LATENCY_BUCKET_COUNT).toBe(bounds.length + 1)
  })

  it("sizes every history range to whole UTC buckets", () => {
    for (const spec of Object.values(RANGE_SPECS)) {
      expect(spec.durationMs).toBe(spec.bucketMs * spec.buckets)
    }
  })
})
