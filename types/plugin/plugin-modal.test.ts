/**
 * Tests for the modal presentation contract shared by the imperative API, the
 * manifest validator and `<PluginModalRoot />`.
 *
 * The resolver is the only thing standing between untyped plugin input and the
 * class lookup that renders a modal, so the cases that matter are the invalid
 * ones: the pre-`options` default has to survive every one of them.
 */

import {
  DEFAULT_PLUGIN_MODAL_SIZE,
  DEFAULT_PLUGIN_MODAL_VARIANT,
  PLUGIN_MODAL_SIZES,
  PLUGIN_MODAL_VARIANTS,
  resolvePluginModalOptions,
  type PluginModalOptions,
} from "./plugin-modal"

describe("resolvePluginModalOptions", () => {
  it("defaults to the pre-options centered/medium presentation", () => {
    expect(resolvePluginModalOptions()).toEqual({ size: "md", variant: "center" })
    expect(resolvePluginModalOptions(undefined)).toEqual({
      size: DEFAULT_PLUGIN_MODAL_SIZE,
      variant: DEFAULT_PLUGIN_MODAL_VARIANT,
    })
    expect(resolvePluginModalOptions({})).toEqual({ size: "md", variant: "center" })
  })

  it("accepts every declared size and variant", () => {
    for (const size of PLUGIN_MODAL_SIZES) {
      expect(resolvePluginModalOptions({ size }).size).toBe(size)
    }
    for (const variant of PLUGIN_MODAL_VARIANTS) {
      expect(resolvePluginModalOptions({ variant }).variant).toBe(variant)
    }
  })

  it("leaves the other axis at its default when only one is given", () => {
    expect(resolvePluginModalOptions({ size: "lg" })).toEqual({ size: "lg", variant: "center" })
    expect(resolvePluginModalOptions({ variant: "sheet-bottom" })).toEqual({
      size: "md",
      variant: "sheet-bottom",
    })
  })

  it("drops unrecognised values rather than propagating them to the renderer", () => {
    const bogus = { size: "enormous", variant: "sheet-left" } as unknown as PluginModalOptions
    expect(resolvePluginModalOptions(bogus)).toEqual({ size: "md", variant: "center" })
  })

  it("lets later sources win field by field", () => {
    expect(
      resolvePluginModalOptions({ size: "sm", variant: "sheet-right" }, { size: "full" })
    ).toEqual({ size: "full", variant: "sheet-right" })
  })

  it("treats an explicit undefined in a later source as 'unspecified', not as a reset", () => {
    expect(
      resolvePluginModalOptions({ variant: "sheet-right" }, { variant: undefined, size: "lg" })
    ).toEqual({ size: "lg", variant: "sheet-right" })
  })

  it("ignores an invalid later source instead of losing the earlier valid one", () => {
    expect(
      resolvePluginModalOptions({ size: "lg" }, { size: "huge" } as unknown as PluginModalOptions)
    ).toEqual({ size: "lg", variant: "center" })
  })
})
