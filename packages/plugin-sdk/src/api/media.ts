/**
 * Plugin SDK - `media` capability runtime surface.
 *
 * Exports the types of `ctx.media`, the API media-capable plugins use for
 * filters and effects. The host builds `ctx.media` and owns its registry.
 */

export type {
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
} from "@cognia/plugin-contract/lib/plugin/api/media-api"
