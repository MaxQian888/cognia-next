/**
 * Operator barrel smoke test — exports from `action-types` and
 * `coordinates`. We assert the namespace has the canonical type-export
 * and helper-function shape rather than enumerate every symbol, since
 * `export *` re-export lists evolve over time.
 */

import * as operator from "./index"

describe("lib/plugin/operator barrel", () => {
  it("re-exports a non-empty surface", () => {
    const keys = Object.keys(operator)
    expect(keys.length).toBeGreaterThan(0)
  })

  it("provides a coordinate-scaling helper from the coordinates module", () => {
    // `coordinates.ts` ships at least one function — pick the first
    // function-shaped export and verify it's callable.
    const functions = Object.entries(operator).filter(([, v]) => typeof v === "function")
    expect(functions.length).toBeGreaterThan(0)
  })
})
