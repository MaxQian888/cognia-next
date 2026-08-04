/** @jest-environment node */
import {
  recordBlockCacheStats,
  recordRenderDuration,
  recordResizeDuration,
  recordUnknownPart,
  resetRenderDiagnostics,
  snapshotRenderDiagnostics,
} from "./render-diagnostics"

describe("render diagnostics", () => {
  beforeEach(() => resetRenderDiagnostics())

  it("reports aggregate counters without prompt/path/payload data", () => {
    recordRenderDuration(12)
    recordRenderDuration(20)
    recordResizeDuration(80)
    recordUnknownPart()
    recordBlockCacheStats({ hits: 9, misses: 1, size: 10, hitRate: 0.9 }, 5, 100)
    const report = snapshotRenderDiagnostics({ TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color" })
    expect(report).toMatchObject({
      engine: "virtualized",
      renderDurationMs: { latest: 20, p95: 20 },
      resizeDurationMs: { latest: 80, p95: 80 },
      blockCacheHitRate: 0.9,
      visibleBlocks: 5,
      totalBlocks: 100,
      unknownParts: 1,
      capabilities: { graphics: "iterm2", hyperlinks: true },
    })
    expect(JSON.stringify(report)).not.toContain("prompt")
  })

  it("uses the supplied environment when selecting the renderer", () => {
    expect(snapshotRenderDiagnostics({ COGNIA_TUI_RENDERER: "legacy" }).engine).toBe("legacy")
  })
})
