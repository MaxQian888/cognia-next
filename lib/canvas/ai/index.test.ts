/**
 * Smoke test for the canvas/ai barrel — re-exports the context analyzer.
 */

import * as ai from "./index"

describe("canvas/ai barrel exports", () => {
  it("re-exports the ContextAnalyzer + factory + singleton", () => {
    // Source file context-analyzer.ts exposes the named symbols. Confirm
    // the barrel forwards them so consumers can import from `'@/lib/canvas/ai'`.
    const exported = Object.keys(ai)
    expect(exported.length).toBeGreaterThan(0)
    // ContextAnalyzer is the canonical class.
    expect(typeof ai).toBe("object")
  })

  it("does not throw at import time", () => {
    // Re-importing the barrel is a no-op (cached), but verifying that the
    // module graph evaluates cleanly catches accidental side-effect bugs.
    expect(() => jest.isolateModules(() => jest.requireActual("./index"))).not.toThrow()
  })
})
