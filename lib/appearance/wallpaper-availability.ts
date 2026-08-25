// Which runtime can actually open a given wallpaper's bytes.
//
// `WallpaperSource` is a union of five shapes, and only three of them are
// values. The other two are *references into one machine's storage*:
//
//   - `disk`      — a relative path under that Tauri host's own
//                   `<appData>/cognia/wallpapers/`, read back through the
//                   `wallpaper_read_data_url` command. Meaningless anywhere
//                   without that command and that directory.
//   - `indexeddb` — a key into the `cognia-wallpapers` IndexedDB store of the
//                   browser/webview that saved it. Meaningless in any other
//                   storage partition.
//
// `saveImage()` picks between the two by `isTauri()`, so a desktop only ever
// writes `disk` and a phone only ever writes `indexeddb` — which means *every
// image wallpaper is device-bound, and the two platforms produce exactly the
// kind the other cannot resolve*. `wallpapers` used to be classified `shared`
// in the settings-sync table, so both galleries filled up with each other's
// unopenable rows; the tile rendered a bare red "!" and stayed clickable, and
// activating one made `resolveSourceToCss` throw, which `BackgroundApplier`
// caught by switching the whole background off.
//
// The classification is fixed (`wallpapers` is `device-local` now), but rows
// mirrored before that stay in the settings row of everyone who was paired.
// This module is what lets the gallery say so instead of showing a "!".
//
// Pure and runtime-free on purpose: the caller passes in whether *it* is the
// desktop host, because `isTauri()` is false during the static-export prerender
// and reading it in render would hydrate into a mismatch.

import type { WallpaperSource } from "@/types/appearance"

/** What a source needs in order to be resolvable at all. */
export type WallpaperBinding =
  /** Self-contained — a CSS value or an inline data URL. Opens anywhere. */
  | "portable"
  /** Needs the Tauri host filesystem that wrote it. */
  | "host-filesystem"
  /** Needs the browser/webview blob store that wrote it. */
  | "local-blob-store"

/** Classify a source by what it needs, independent of where we are now. */
export function wallpaperBinding(source: WallpaperSource): WallpaperBinding {
  if (source.kind === "gradient" || source.kind === "color") return "portable"
  switch (source.storage) {
    case "data-url":
      return "portable"
    case "disk":
      return "host-filesystem"
    case "indexeddb":
      return "local-blob-store"
  }
}

/**
 * True when this runtime holds the storage the source points at.
 *
 * `isDesktopHost` is `isTauri()`: a Tauri webview owns the wallpaper directory
 * and can invoke `wallpaper_read_data_url`, and is also the one runtime that
 * never writes `indexeddb` rows — so an `indexeddb` row seen on the desktop
 * came from somewhere else. Everywhere else the pair is reversed.
 */
export function canResolveWallpaperHere(source: WallpaperSource, isDesktopHost: boolean): boolean {
  const binding = wallpaperBinding(source)
  if (binding === "portable") return true
  return binding === "host-filesystem" ? isDesktopHost : !isDesktopHost
}

/**
 * i18n key suffix under `settings.appearance.wallpaper.unavailable` naming why
 * this device cannot open the wallpaper, or null when it can.
 *
 * The two cases are worth separating because the user's next move differs: a
 * `disk` row is still openable — just on the desktop app — whereas an
 * `indexeddb` row is stranded in whichever handset or browser profile saved it.
 */
export function wallpaperUnavailableReason(
  source: WallpaperSource,
  isDesktopHost: boolean
): "savedOnDesktop" | "savedOnAnotherDevice" | null {
  if (canResolveWallpaperHere(source, isDesktopHost)) return null
  return wallpaperBinding(source) === "host-filesystem" ? "savedOnDesktop" : "savedOnAnotherDevice"
}
