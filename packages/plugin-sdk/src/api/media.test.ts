import * as sdk from "./media"
import type {
  ExportProgress,
  FilterParameterDefinition,
  ImageAdjustmentOptions,
  ImageFilterDefinition,
  ImageProcessingOptions,
  ImageTransformOptions,
  MediaProcessingResult,
  PluginMediaAPI,
  VideoClip,
  VideoEffectDefinition,
  VideoExportOptions,
  VideoTransition,
  VideoTransitionDefinition,
} from "./media"

describe("plugin-sdk api/media", () => {
  it("keeps host wiring off the author surface (plugins reach it through ctx.media)", () => {
    expect(sdk).not.toHaveProperty("createMediaAPI")
    expect(sdk).not.toHaveProperty("getMediaRegistry")
  })

  it("re-exports media runtime API and companion types", () => {
    const assertTypes = <
      _T extends
        | PluginMediaAPI
        | ImageProcessingOptions
        | ImageFilterDefinition
        | FilterParameterDefinition
        | ImageTransformOptions
        | ImageAdjustmentOptions
        | VideoClip
        | VideoTransition
        | VideoEffectDefinition
        | VideoTransitionDefinition
        | VideoExportOptions
        | ExportProgress
        | MediaProcessingResult,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
