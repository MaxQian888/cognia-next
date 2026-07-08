/** @jest-environment jsdom */
/**
 * Tests for log-filter-presets — small persistence helpers that serialise
 * the log panel's filter chips into `localStorage`.
 *
 * The hook tests cover the panel/UI wiring; this suite drives the
 * pure functions directly so every branch of the `isValidPreset` guard
 * is exercised, including the obvious "garbage in, empty list out" paths
 * that the higher-level consumers depend on for crash-safety.
 */

import {
  createLogFilterPreset,
  loadLogFilterPresets,
  serializeLogFilterPresets,
  LOG_FILTER_PRESETS_STORAGE_KEY,
  type LogFilterPreset,
  type LogFilterPresetFilters,
} from "./filter-presets"

const baseFilters: LogFilterPresetFilters = {
  levelFilter: "warn",
  moduleFilter: "ai",
  timeRange: "1h",
  searchQuery: "boom",
  useRegex: false,
  highSeverityOnly: true,
}

function makePreset(overrides: Partial<LogFilterPreset> = {}): LogFilterPreset {
  return {
    id: "p1",
    name: "Recent warnings",
    version: 1,
    createdAt: "2026-05-21T00:00:00.000Z",
    filters: baseFilters,
    ...overrides,
  }
}

describe("LOG_FILTER_PRESETS_STORAGE_KEY", () => {
  it("uses the documented localStorage key so consumers stay in lockstep", () => {
    expect(LOG_FILTER_PRESETS_STORAGE_KEY).toBe("cognia-log-filter-presets")
  })
})

describe("createLogFilterPreset", () => {
  it("trims the user-supplied display name", () => {
    const preset = createLogFilterPreset("   Errors only   ", baseFilters)
    expect(preset.name).toBe("Errors only")
  })

  it("stamps version 1 (current schema version)", () => {
    const preset = createLogFilterPreset("Recent", baseFilters)
    expect(preset.version).toBe(1)
  })

  it("auto-generates an id with the `preset-` prefix when none supplied", () => {
    const preset = createLogFilterPreset("a", baseFilters)
    expect(preset.id.startsWith("preset-")).toBe(true)
  })

  it("respects an explicit id (used by import/round-trip flows)", () => {
    const preset = createLogFilterPreset("Recent", baseFilters, "preset-fixed-id")
    expect(preset.id).toBe("preset-fixed-id")
  })

  it("records createdAt as an ISO 8601 timestamp", () => {
    const preset = createLogFilterPreset("Recent", baseFilters)
    expect(() => new Date(preset.createdAt).toISOString()).not.toThrow()
    expect(preset.createdAt).toBe(new Date(preset.createdAt).toISOString())
  })

  it("pins through the filter payload byref so subsequent mutations leak", () => {
    // Sanity check that the helper does not deep-clone; the caller passes a
    // fresh object literal and the preset stores that exact reference.
    const filters = { ...baseFilters }
    const preset = createLogFilterPreset("Recent", filters)
    expect(preset.filters).toBe(filters)
  })
})

describe("serializeLogFilterPresets", () => {
  it("round-trips a non-empty array via JSON.parse", () => {
    const presets = [makePreset(), makePreset({ id: "p2", name: "Errors only" })]
    const raw = serializeLogFilterPresets(presets)
    expect(JSON.parse(raw)).toEqual(presets)
  })

  it("serialises an empty array to '[]'", () => {
    expect(serializeLogFilterPresets([])).toBe("[]")
  })
})

describe("loadLogFilterPresets", () => {
  it("returns [] when the raw input is null (cold start)", () => {
    expect(loadLogFilterPresets(null)).toEqual([])
  })

  it("returns [] when the raw input is an empty string", () => {
    expect(loadLogFilterPresets("")).toEqual([])
  })

  it("returns [] when the raw input is not valid JSON", () => {
    expect(loadLogFilterPresets("not-json")).toEqual([])
  })

  it("returns [] when the JSON parses to something other than an array", () => {
    expect(loadLogFilterPresets(JSON.stringify({ id: "p1" }))).toEqual([])
    expect(loadLogFilterPresets(JSON.stringify(null))).toEqual([])
    expect(loadLogFilterPresets(JSON.stringify("plain"))).toEqual([])
  })

  it("returns the parsed presets when every entry is well-formed", () => {
    const presets = [makePreset(), makePreset({ id: "p2", name: "Errors only" })]
    const raw = serializeLogFilterPresets(presets)
    expect(loadLogFilterPresets(raw)).toEqual(presets)
  })

  it("filters out invalid entries while keeping the valid ones", () => {
    const good = makePreset()
    const tampered = [
      good,
      null, // non-object
      { id: 1 }, // wrong type for id
      { ...good, name: undefined }, // missing name
      { ...good, version: "1" }, // version not a number
      { ...good, createdAt: 0 }, // createdAt not a string
      { ...good, filters: undefined }, // missing filters
    ]
    const raw = JSON.stringify(tampered)
    expect(loadLogFilterPresets(raw)).toEqual([good])
  })

  it("rejects presets whose filters omit a string field", () => {
    const good = makePreset()
    const bad = {
      ...good,
      filters: { ...good.filters, moduleFilter: 7 },
    }
    expect(loadLogFilterPresets(JSON.stringify([bad]))).toEqual([])
  })

  it("rejects presets whose filters omit a boolean flag", () => {
    const good = makePreset()
    const bad = {
      ...good,
      filters: { ...good.filters, useRegex: "false" },
    }
    expect(loadLogFilterPresets(JSON.stringify([bad]))).toEqual([])
  })

  it("rejects presets with an unknown levelFilter", () => {
    const good = makePreset()
    const bad = {
      ...good,
      filters: { ...good.filters, levelFilter: "panic" },
    }
    expect(loadLogFilterPresets(JSON.stringify([bad]))).toEqual([])
  })

  it("rejects presets with an unknown timeRange", () => {
    const good = makePreset()
    const bad = {
      ...good,
      filters: { ...good.filters, timeRange: "3d" },
    }
    expect(loadLogFilterPresets(JSON.stringify([bad]))).toEqual([])
  })

  it("accepts every valid level + time range combination", () => {
    const levels = ["all", "trace", "debug", "info", "warn", "error", "fatal"] as const
    const ranges = ["all", "15m", "1h", "6h", "24h", "7d"] as const
    const presets = levels.flatMap((levelFilter, i) =>
      ranges.map((timeRange, j) =>
        makePreset({
          id: `p-${i}-${j}`,
          filters: { ...baseFilters, levelFilter, timeRange },
        })
      )
    )
    expect(loadLogFilterPresets(JSON.stringify(presets))).toEqual(presets)
  })
})
