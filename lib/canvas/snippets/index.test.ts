/**
 * Smoke test for the canvas/snippets barrel.
 */

import * as snippets from "./index"

describe("canvas/snippets barrel exports", () => {
  it("re-exports the snippet registry symbols", () => {
    const keys = Object.keys(snippets)
    expect(keys.length).toBeGreaterThan(0)
  })

  it("does not throw at import time", () => {
    expect(() => jest.isolateModules(() => jest.requireActual("./index"))).not.toThrow()
  })
})
