/**
 * @jest-environment node
 *
 * Node's global `performance` (perf_hooks) implements the full W3C User
 * Timing API. jsdom (the default Jest env) only ships `performance.now()`
 * + `timeOrigin`, so `performance.mark`/`measure`/`getEntriesByName` are
 * `undefined` there. We run this suite under the Node env so the helpers
 * can be exercised against a real timing implementation.
 */

import {
  PERF_NAMESPACE,
  mark,
  measure,
  measureRange,
  clearPerfEntries,
  clearMeasuresByName,
} from "./perf-marker"

describe("perf-marker", () => {
  beforeEach(() => {
    clearPerfEntries()
  })

  afterAll(() => {
    clearPerfEntries()
  })

  it("namespace constant has the workflow-ai prefix", () => {
    expect(PERF_NAMESPACE).toBe("workflow-ai:")
  })

  it("mark() writes a namespaced PerformanceMark entry", () => {
    mark("stream-start")
    const entries = performance.getEntriesByName(`${PERF_NAMESPACE}stream-start`)
    expect(entries).toHaveLength(1)
    expect(entries[0].entryType).toBe("mark")
  })

  it("measure() emits a measure entry between two marks", () => {
    mark("apply-start")
    mark("apply-end")
    const duration = measure("apply", "apply-start", "apply-end")
    const entries = performance.getEntriesByName(`${PERF_NAMESPACE}apply`)
    expect(entries).toHaveLength(1)
    expect(entries[0].entryType).toBe("measure")
    expect(duration).toBeGreaterThanOrEqual(0)
  })

  it("measure() returns undefined when the start mark is missing", () => {
    const duration = measure("never-started", "missing-start", "missing-end")
    expect(duration).toBeUndefined()
  })

  it("measure() without an end mark uses 'now' as the implicit end", () => {
    mark("stream-start")
    const duration = measure("stream", "stream-start")
    const entries = performance.getEntriesByName(`${PERF_NAMESPACE}stream`)
    expect(entries).toHaveLength(1)
    expect(duration).toBeGreaterThanOrEqual(0)
  })

  it("measureRange() writes a measure entry with the supplied span", () => {
    measureRange("react:chat:message", 100, 116.5)
    const entries = performance.getEntriesByName(`${PERF_NAMESPACE}react:chat:message`)
    expect(entries).toHaveLength(1)
    const e = entries[0] as PerformanceMeasure
    expect(e.entryType).toBe("measure")
    expect(e.duration).toBeCloseTo(16.5, 1)
  })

  it("clearPerfEntries() drops only namespaced entries", () => {
    performance.mark("unrelated-mark")
    mark("after-clear")
    clearPerfEntries()
    expect(performance.getEntriesByName(`${PERF_NAMESPACE}after-clear`)).toHaveLength(0)
    expect(performance.getEntriesByName("unrelated-mark")).toHaveLength(1)
    performance.clearMarks("unrelated-mark")
  })

  it("clearMeasuresByName() drains every entry of one name, leaving others", () => {
    // Two commits of the same boundary share a single measure name — the
    // exact shape that grows unbounded in a long session.
    measureRange("react:chat:message", 0, 4)
    measureRange("react:chat:message", 0, 6)
    measureRange("react:chat:list", 0, 2)
    expect(performance.getEntriesByName(`${PERF_NAMESPACE}react:chat:message`)).toHaveLength(2)

    clearMeasuresByName(`${PERF_NAMESPACE}react:chat:message`)

    expect(performance.getEntriesByName(`${PERF_NAMESPACE}react:chat:message`)).toHaveLength(0)
    // Unrelated boundary's entry is untouched.
    expect(performance.getEntriesByName(`${PERF_NAMESPACE}react:chat:list`)).toHaveLength(1)
  })
})
