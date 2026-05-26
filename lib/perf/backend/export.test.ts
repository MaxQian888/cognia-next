/**
 * @jest-environment jsdom
 */

const downloadFileMock = jest.fn()
jest.mock("@/lib/files/download", () => ({
  downloadFile: (...args: unknown[]) => downloadFileMock(...args),
}))

import {
  buildPerfExportFilename,
  exportPerfSnapshot,
  processesToCsv,
  snapshotToJson,
  spansToCsv,
} from "./export"
import type { PerfSample, ProcessSample, SpanSnapshot } from "./types"

function makeProcess(overrides: Partial<ProcessSample> = {}): ProcessSample {
  return {
    pid: 1,
    parentPid: null,
    name: "cognia",
    role: "main",
    cpuPct: 12.5,
    cpuPctRaw: 50,
    memBytes: 1024,
    diskReadBps: 0,
    diskWriteBps: 0,
    runSecs: 60,
    ...overrides,
  }
}

function makeSpan(overrides: Partial<SpanSnapshot> = {}): SpanSnapshot {
  return {
    name: "claude.send",
    count: 3,
    errorCount: 1,
    totalMs: 30,
    avgMs: 10,
    minMs: 5,
    maxMs: 20,
    p50Ms: 8,
    p95Ms: 18,
    lastTsMs: 123,
    buckets: new Array(25).fill(0),
    ...overrides,
  }
}

function makeSample(): PerfSample {
  return {
    tsMs: 1,
    intervalMs: 1000,
    processes: [makeProcess()],
    runtime: {
      workers: 1,
      aliveTasks: 0,
      globalQueueDepth: 0,
      blockingThreads: 0,
      blockingQueueDepth: 0,
      spawnedTasksCount: 0,
      budgetForcedYieldCount: 0,
      workerStealCount: 0,
      workerParkCount: 0,
      workerOverflowCount: 0,
      busyPct: 0,
      perWorkerBusyPct: [0],
    },
    topSpans: [makeSpan()],
    systemMemory: null,
  }
}

beforeEach(() => downloadFileMock.mockReset())

describe("processesToCsv", () => {
  it("emits a header row and one row per process", () => {
    const csv = processesToCsv([makeProcess(), makeProcess({ pid: 2, name: "node" })])
    const lines = csv.split("\n")
    expect(lines[0]).toContain("pid,parentPid,name,role")
    expect(lines).toHaveLength(3)
    expect(lines[2]).toContain("node")
  })

  it("RFC-4180-escapes names with commas", () => {
    const csv = processesToCsv([makeProcess({ name: "weird,name" })])
    expect(csv).toContain('"weird,name"')
  })
})

describe("spansToCsv", () => {
  it("emits a header row and one row per span", () => {
    const csv = spansToCsv([makeSpan()])
    expect(csv.split("\n")[0]).toContain("name,count,errorCount")
    expect(csv).toContain("claude.send")
  })
})

describe("snapshotToJson", () => {
  it("includes metadata, latest, and history", () => {
    const parsed = JSON.parse(snapshotToJson(makeSample(), [makeSample(), makeSample()], 0))
    expect(parsed.exportedAt).toBe("1970-01-01T00:00:00.000Z")
    expect(parsed.intervalMs).toBe(1000)
    expect(parsed.sampleCount).toBe(2)
    expect(parsed.latest.tsMs).toBe(1)
    expect(parsed.history).toHaveLength(2)
  })

  it("handles a null latest", () => {
    const parsed = JSON.parse(snapshotToJson(null, [], 0))
    expect(parsed.intervalMs).toBeNull()
    expect(parsed.latest).toBeNull()
  })
})

describe("buildPerfExportFilename", () => {
  it("uses the json extension and snapshot kind", () => {
    expect(buildPerfExportFilename("json", Date.UTC(2026, 4, 26, 9, 5))).toBe(
      "cognia-perf-snapshot-202605260905.json"
    )
  })

  it("uses the csv extension and the matching kind", () => {
    expect(buildPerfExportFilename("csv-processes", 0)).toMatch(
      /^cognia-perf-processes-\d{12}\.csv$/
    )
    expect(buildPerfExportFilename("csv-hotspots", 0)).toMatch(/^cognia-perf-hotspots-\d{12}\.csv$/)
  })
})

describe("exportPerfSnapshot", () => {
  it("downloads JSON with the application/json mime", () => {
    const res = exportPerfSnapshot({
      latest: makeSample(),
      history: [makeSample()],
      format: "json",
      now: 0,
    })
    expect(res).toEqual({ filename: expect.stringContaining(".json"), mime: "application/json" })
    expect(downloadFileMock).toHaveBeenCalledWith(
      expect.stringContaining(".json"),
      expect.stringContaining('"sampleCount"'),
      "application/json"
    )
  })

  it("downloads the process CSV", () => {
    exportPerfSnapshot({ latest: makeSample(), history: [], format: "csv-processes", now: 0 })
    expect(downloadFileMock).toHaveBeenCalledWith(
      expect.stringContaining(".csv"),
      expect.stringContaining("pid,parentPid"),
      "text/csv;charset=utf-8"
    )
  })

  it("downloads the hotspots CSV", () => {
    exportPerfSnapshot({ latest: makeSample(), history: [], format: "csv-hotspots", now: 0 })
    expect(downloadFileMock).toHaveBeenCalledWith(
      expect.stringContaining(".csv"),
      expect.stringContaining("claude.send"),
      "text/csv;charset=utf-8"
    )
  })

  it("falls back to empty tables when latest is null", () => {
    const res = exportPerfSnapshot({ latest: null, history: [], format: "csv-processes", now: 0 })
    expect(res?.mime).toBe("text/csv;charset=utf-8")
    expect(downloadFileMock).toHaveBeenCalled()
  })
})
