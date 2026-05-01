import * as indexExports from "./index"
import * as storeExports from "./a2ui-store"

describe("stores/a2ui index exports", () => {
  it("re-exports the A2UI store module without a default export", () => {
    expect(Object.keys(indexExports).sort()).toEqual(Object.keys(storeExports).sort())
    expect((indexExports as { default?: unknown }).default).toBeUndefined()
  })
})
