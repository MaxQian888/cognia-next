/**
 * Plugin SDK - `media` capability runtime surface.
 *
 * Re-exports the host media API exposed as `ctx.media` plus the shared
 * filter/effect registry used by media-capable plugins.
 */

export { createMediaAPI, getMediaRegistry } from "@/lib/plugin/api/media-api"

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
} from "@/lib/plugin/api/media-api"
