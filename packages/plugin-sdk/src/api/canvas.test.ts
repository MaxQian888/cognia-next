import * as sdk from "./canvas"
import type {
  CanvasSelection,
  CreateCanvasDocumentOptions,
  PluginCanvasAPI,
  PluginCanvasDocument,
} from "./canvas"

describe("plugin-sdk api/canvas", () => {
  it("exposes the canvas runtime API factory", () => {
    expect(typeof sdk.createCanvasAPI).toBe("function")
  })

  it("re-exports canvas runtime API and document types", () => {
    const assertTypes = <
      _T extends
        | PluginCanvasAPI
        | PluginCanvasDocument
        | CreateCanvasDocumentOptions
        | CanvasSelection,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
