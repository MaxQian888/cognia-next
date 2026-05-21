/**
 * Smoke test for the logging barrel — guards the public re-export surface so
 * a downstream consumer doing
 *   `import { LogPanel } from "@/components/logging"`
 * keeps compiling even after the underlying files move or rename.
 */

import "@testing-library/jest-dom"

// IMPORTANT: keep the import going *through* the barrel (no deep paths) so
// each named export contributes to coverage of `components/logging/index.ts`.
import {
  LogPanel,
  LogSettings,
  LogStatsDashboard,
  LogTimeline,
  LogDetailPanel,
  LogPanelToolbar,
  LogPanelStatsBar,
  TransportHealthDetail,
  NativeLoggingDetail,
  VirtualizedLogList,
  LogEntry,
  MemoizedLogEntry,
  TraceGroup,
  HighlightedText,
  LEVEL_THEME,
  ALL_LEVELS,
} from "./index"

describe("components/logging barrel", () => {
  it("re-exports every documented component as a function/forwardRef", () => {
    const components = {
      LogPanel,
      LogSettings,
      LogStatsDashboard,
      LogTimeline,
      LogDetailPanel,
      LogPanelToolbar,
      LogPanelStatsBar,
      TransportHealthDetail,
      NativeLoggingDetail,
      VirtualizedLogList,
      LogEntry,
      MemoizedLogEntry,
      TraceGroup,
      HighlightedText,
    } as const
    for (const [name, value] of Object.entries(components)) {
      // React components are either plain function components, memoised
      // components (object with a `type` ref), or `forwardRef` payloads
      // (object). Anything else means the barrel diverged from the source.
      if (value === undefined) {
        throw new Error(`Barrel export "${name}" is undefined`)
      }
      expect(["function", "object"]).toContain(typeof value)
    }
  })

  it("re-exports the level value-tables in a stable shape", () => {
    expect(Array.isArray(ALL_LEVELS)).toBe(true)
    expect(ALL_LEVELS.length).toBeGreaterThan(0)
    expect(typeof LEVEL_THEME).toBe("object")
    expect(LEVEL_THEME).not.toBeNull()
    // Every level name in ALL_LEVELS should resolve to a theme entry — the
    // toolbar relies on this 1:1 mapping to colour chips.
    for (const level of ALL_LEVELS) {
      expect(LEVEL_THEME).toHaveProperty(level)
    }
  })
})
