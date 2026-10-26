/**
 * Plugin SDK — `font-contribution` capability surface.
 *
 * Re-exports the authoring helper, font bridge, and cross-source font
 * registry used by plugin-bundled font families.
 */

export { defineFontContribution } from "../define/define-font-contribution"

export {
  applyPluginFonts,
  buildFontFaceRule,
  cssFormatHintFor,
  detectFontKind,
  revertPluginFonts,
} from "@cognia/plugin-contract/lib/plugin/bridge/font-bridge"

export type {
  ApplyPluginFontsArgs,
  ApplyPluginFontsResult,
  ResolveAssetFn,
} from "@cognia/plugin-contract/lib/plugin/bridge/font-bridge"

export {
  findFont,
  fontRegistrySnapshot,
  listFonts,
  registerPluginFont,
  setSystemFonts,
  subscribeFonts,
  unregisterPluginFontsByPlugin,
} from "@cognia/plugin-contract/lib/appearance/font-registry"

export type { FontEntry, FontSource } from "@cognia/plugin-contract/lib/appearance/font-registry"
export type {
  PluginFontContribution,
  PluginFontFile,
} from "@cognia/plugin-contract/types/plugin/plugin"
