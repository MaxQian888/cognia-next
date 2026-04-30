/**
 * Smoke test for the canvas/symbols barrel.
 */

import * as symbols from "./index"

describe("canvas/symbols barrel exports", () => {
  it("re-exports the SymbolParser symbol surface", () => {
    expect(typeof symbols.SymbolParser).toBe("function")
    expect(symbols.symbolParser).toBeInstanceOf(symbols.SymbolParser)
  })
})
