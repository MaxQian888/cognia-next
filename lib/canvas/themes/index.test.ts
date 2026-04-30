/**
 * Smoke test for the canvas/themes barrel.
 */

import * as themes from "./index"

describe("canvas/themes barrel exports", () => {
  it("re-exports the theme registry surface", () => {
    const keys = Object.keys(themes)
    expect(keys.length).toBeGreaterThan(0)
  })

  it("does not throw at import time", () => {
    expect(() => jest.isolateModules(() => jest.requireActual("./index"))).not.toThrow()
  })
})
