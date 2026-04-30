/**
 * @jest-environment jsdom
 *
 * Smoke test for the top-level canvas barrel.
 */

import * as canvas from "./index"

describe("canvas barrel exports", () => {
  it("re-exports large-file-optimizer surface", () => {
    expect(typeof canvas.LargeFileOptimizer).toBe("function")
  })

  it("re-exports plugin manager", () => {
    expect(typeof canvas.CanvasPluginManager).toBe("function")
  })

  it("re-exports CRDT store + websocket provider", () => {
    expect(typeof canvas.CanvasCRDTStore).toBe("function")
    expect(typeof canvas.CanvasWebSocketProvider).toBe("function")
  })

  it("re-exports SymbolParser as a named symbol (re-export form)", () => {
    expect(typeof canvas.SymbolParser).toBe("function")
    expect(canvas.symbolParser).toBeInstanceOf(canvas.SymbolParser)
  })

  it("does not throw at import time", () => {
    expect(() => jest.isolateModules(() => jest.requireActual("./index"))).not.toThrow()
  })
})
