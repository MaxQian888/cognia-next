import * as sdk from "./index"
import type {
  CanonicalExtensionPoint,
  ExtensionPoint,
  ExtensionOptions,
  ExtensionProps,
} from "./index"

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

  it("exposes the host form factor on extension component props", () => {
    const props: ExtensionProps = {
      pluginId: "example",
      extensionId: "toolbar-action",
      formFactor: "row",
    }
    expect(props.formFactor).toBe("row")
  })

  it("publishes an exhaustive form-factor map", () => {
    expect(Object.keys(sdk.EXTENSION_POINT_FORM_FACTORS).sort()).toEqual(
      [...sdk.CANONICAL_EXTENSION_POINTS].sort()
    )
    expect(sdk.EXTENSION_POINT_FORM_FACTORS["statusbar.right"]).toBe("icon")
    expect(sdk.EXTENSION_POINT_FORM_FACTORS["sidebar.right.top"]).toBe("panel")
  })
})
