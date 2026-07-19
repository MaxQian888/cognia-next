import * as sdk from "./index"
import type { CanonicalExtensionPoint, ExtensionPoint, ExtensionOptions } from "./index"

describe("plugin-sdk: extensions", () => {
  it("re-exports the canonical extension-point list as a non-empty const tuple", () => {
    expect(Array.isArray(sdk.CANONICAL_EXTENSION_POINTS)).toBe(true)
    expect(sdk.CANONICAL_EXTENSION_POINTS.length).toBeGreaterThan(0)
  })

  it("does not expose host proof lookup helpers", () => {
    expect((sdk as Record<string, unknown>).getExtensionPointContract).toBeUndefined()
  })

  it("ExtensionPoint is an alias of CanonicalExtensionPoint", () => {
    const point: CanonicalExtensionPoint = sdk.CANONICAL_EXTENSION_POINTS[0]
    const aliased: ExtensionPoint = point
    expect(aliased).toBe(point)
  })

  it("re-exports ExtensionOptions for plugin-side registration calls", () => {
    const opts: ExtensionOptions = { priority: 10 }
    expect(opts.priority).toBe(10)
  })
})
