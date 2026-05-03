// Appearance customization types: wallpapers, background scopes, VSCode-import
// records, and custom-CSS state. These piggy-back on `AppSettings` (Dexie
// `settings` singleton) — no separate table — so the whole appearance config
// rides along with the existing backup/restore pipeline.

export type WallpaperPosition = "cover" | "contain" | "tile" | "center"

export type BackgroundScope = "all" | "global" | "chat" | "canvas" | "sidebar"

export interface BackgroundSettings {
  enabled: boolean
  /** Points to {@link Wallpaper.id} in `AppSettings.wallpapers`. Null = no active wallpaper. */
  activeId: string | null
  scope: BackgroundScope
  /** 0..32 px. Applied as `filter: blur(Npx)` on the body::before pseudo. */
  blurPx: number
  /** 0..1. Applied as `opacity: N` on the body::before pseudo. */
  opacity: number
  position: WallpaperPosition
}

export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = {
  enabled: false,
  activeId: null,
  scope: "all",
  blurPx: 0,
  opacity: 1,
  position: "cover",
}

/** Discriminated union — exactly one of these shapes per wallpaper. */
export type WallpaperSource =
  | {
      kind: "image"
      storage: "disk"
      /** Relative path under `<appData>/cognia/wallpapers/`. */
      relPath: string
      mime: string
      width: number
      height: number
    }
  | {
      kind: "image"
      storage: "indexeddb"
      /** Key into the IndexedDB Blob store. */
      blobKey: string
      mime: string
      width: number
      height: number
    }
  | {
      kind: "image"
      storage: "data-url"
      /** Inline data URL — used for built-in image presets shipped with the app. */
      dataUrl: string
      mime: string
      width: number
      height: number
    }
  | {
      kind: "gradient"
      /** Raw CSS gradient string, e.g. "linear-gradient(135deg, #ff7e5f, #feb47b)". */
      css: string
    }
  | {
      kind: "color"
      /** CSS color value, e.g. "#1e293b" or "oklch(0.5 0.1 30)". */
      value: string
    }

export interface Wallpaper {
  id: string
  name: string
  /** Top-level kind — duplicates `source.kind` for fast filtering in the gallery. */
  kind: "image" | "gradient" | "color"
  source: WallpaperSource
  /** Cannot be deleted; rendered first in the gallery. */
  builtin: boolean
  createdAt: number
}

/**
 * One row per VSCode theme imported. The actual color tokens live in
 * `AppSettings.customThemes`; this record just remembers where a custom theme
 * came from so the UI can show provenance and offer "remove" / "re-import".
 */
export interface ImportedThemeRecord {
  /** Foreign key into `AppSettings.customThemes[].id`. */
  customThemeId: string
  /** Human-readable name from the VSCode theme `label`. */
  sourceName: string
  /** Whether the imported theme targets light or dark UI. */
  sourceVariant: "light" | "dark"
  importedAt: number
  origin: { kind: "json"; fileName: string } | { kind: "vsix"; vsixName: string; themePath: string }
}

/**
 * Bundle of every appearance-related slice. `AppSettings` spreads these in
 * directly so a single Dexie write persists the whole config.
 */
export interface AppearanceSettingsSlice {
  background?: BackgroundSettings
  wallpapers?: Wallpaper[]
  /** User-supplied global CSS, applied via a `<style id="cognia-user-css">` tag. */
  customCss?: string
  customCssEnabled?: boolean
  importedVscodeThemes?: ImportedThemeRecord[]
}

/** Defaults filled in by `getSettings()` for back-compat with older rows. */
export const DEFAULT_APPEARANCE_SLICE: Required<AppearanceSettingsSlice> = {
  background: DEFAULT_BACKGROUND_SETTINGS,
  wallpapers: [],
  customCss: "",
  customCssEnabled: false,
  importedVscodeThemes: [],
}
