/** @jest-environment node */
import { performance } from "node:perf_hooks"
import {
  anchorAtRow,
  buildVirtualBlockIndex,
  rowForAnchor,
  virtualWindow,
  type VirtualBlockMetric,
} from "./virtual-block-index"

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0
}

describe("virtualized transcript performance budget", () => {
  it("keeps 1,000 cells / 10,000 rows within interaction and resize budgets", () => {
    const metrics: VirtualBlockMetric[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `cell-${index}`,
      rows: 10,
    }))
    const index = buildVirtualBlockIndex(metrics)
    expect(index.totalRows).toBe(10_000)

    const interactionSamples: number[] = []
    for (let iteration = 0; iteration < 250; iteration += 1) {
      const started = performance.now()
      const top = (iteration * 37) % 9_976
      const window = virtualWindow(index, top, 24, 2)
      const anchor = anchorAtRow(index, top)
      expect(rowForAnchor(index, anchor)).toBe(top)
      expect(window.end - window.start).toBeLessThanOrEqual(13)
      interactionSamples.push(performance.now() - started)
    }
    expect(percentile95(interactionSamples)).toBeLessThan(50)

    const resizeStarted = performance.now()
    const corrected = buildVirtualBlockIndex(
      metrics.map((metric, position) => ({ ...metric, rows: position % 3 === 0 ? 12 : 9 }))
    )
    const resizeDuration = performance.now() - resizeStarted
    expect(corrected.totalRows).toBeGreaterThan(0)
    expect(resizeDuration).toBeLessThan(150)
  })
})
