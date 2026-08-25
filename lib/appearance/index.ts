// Barrel export for the appearance module. Components import from
// `@/lib/appearance` rather than reaching into individual files.

export { BackgroundApplier } from "./background-applier"
export {
  ComponentStyleApplier,
  applyComponentStyleCss,
  clampRadiusScale,
  resolveComponentStyleCss,
} from "./component-style-applier"
export {
  COMPONENT_STYLE_REGISTRY,
  COMPONENT_STYLE_BY_KEY,
  COMPONENT_STYLE_GROUPS,
} from "./component-style-registry"
export type {
  ComponentPlacement,
  ComponentStyleEntry,
  ComponentStyleGroup,
} from "./component-style-registry"
export { CursorApplier, resolveCursorStyle } from "./cursor/cursor-applier"
export {
  CURSOR_PACKS,
  CURSOR_PACKS_BY_ID,
  CURSOR_PACK_FAMILIES,
  getCursorPack,
  packsInFamily,
} from "./cursor/cursor-packs"
export {
  CURSOR_ROLE_SELECTORS,
  CURSOR_ROOT_ATTR,
  CURSOR_STYLE_ELEMENT_ID,
  buildCursorCss,
} from "./cursor/cursor-css"
export {
  CURSOR_BASE_PX,
  CURSOR_MAX_PX,
  cursorPixelSize,
  renderPackRoles,
  resolveCursorPalette,
  svgToDataUrl,
} from "./cursor/render-cursor"
export { useCursorAccentColor } from "./cursor/use-cursor-accent"
export { TypographyApplier, resolveTypographyVars } from "./typography-applier"
export { DensityApplier, resolveDensityAttrs, densitySurfaceProps } from "./density-applier"
export { RadiusApplier, resolveRadiusVar } from "./radius-applier"
export { StylePackApplier, resolveStylePackDom } from "./style-pack-applier"
export { MotionApplier, resolveMotionState } from "./motion-applier"
export {
  FOCAL_PRESETS,
  WALLPAPER_POSITIONS,
  backgroundFitStyle,
  clampFocal,
  focalPresetId,
  resolveBackgroundFit,
  supportsFocalPoint,
} from "./background-fit"
export type { BackgroundFit, FocalPreset } from "./background-fit"
export {
  AA_LARGE_TEXT,
  AA_NORMAL_TEXT,
  bandRatio,
  computeOpacityVerdict,
  effectiveContrast,
  maxOpacityForRatio,
  readThemeColors,
  wallpaperFloorRatio,
} from "./wallpaper-readability"
export type {
  OpacityVerdict,
  ReadabilityBand,
  ReadabilityVerdict as WallpaperReadabilityVerdict,
} from "./wallpaper-readability"
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
export {
  ACCEPTED_WALLPAPER_MIMES,
  intakeWallpaperFile,
  isAcceptedWallpaperType,
} from "./wallpaper-intake"
export type {
  UploadedWallpaper,
  WallpaperIntakeResult,
  WallpaperRejection,
} from "./wallpaper-intake"
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
