// Barrel export for the appearance module. Components import from
// `@/lib/appearance` rather than reaching into individual files.

export { BackgroundApplier } from "./background-applier"
export { TypographyApplier, resolveTypographyVars } from "./typography-applier"
export { DensityApplier, resolveDensityAttrs, densitySurfaceProps } from "./density-applier"
export { RadiusApplier, resolveRadiusVar } from "./radius-applier"
export { MotionApplier, resolveMotionState } from "./motion-applier"
export {
  BUILTIN_COLOR_PRESETS,
  BUILTIN_GRADIENT_PRESETS,
  BUILTIN_WALLPAPERS,
  isBuiltinPresetId,
  withBuiltinPresets,
} from "./presets"
export {
  MAX_WALLPAPER_BYTES,
  arrayBufferToBase64,
  deleteImage,
  disposeUrl,
  makeWallpaper,
  mimeToExtension,
  resolveSourceToCss,
  saveImage,
} from "./wallpaper-storage"
export type { SaveImageResult } from "./wallpaper-storage"
export { applyUserCss, removeUserCss, sanitizeUserCss } from "./custom-css/apply"
export {
  importVscodeThemeJson,
  parseVscodeJson,
  vscodeThemeToCustomTheme,
} from "./vscode-theme/parse-json"
export type { ParsedTheme, VscodeThemeJson } from "./vscode-theme/parse-json"
export { MAX_VSIX_BYTES, readVsix } from "./vscode-theme/parse-vsix"
export type { VsixManifest, VsixThemeReady } from "./vscode-theme/parse-vsix"
export { THEME_COLOR_KEYS, DEFAULT_FALLBACKS } from "./vscode-theme/token-mapping"
