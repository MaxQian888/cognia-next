/**
 * Shell tag the OCR pipeline branches on when selecting a provider.
 *
 * Vendored from the app's `lib/platform/detect` (`Platform`, re-exported there
 * as `NativePlatform`) so this package carries no app import. Detection itself
 * stays app-side — `buildOcrDeps()` calls `detectPlatform()` and passes the
 * resulting tag in through `ExtractDeps.platform`.
 */
export type NativePlatform = "tauri" | "mobile" | "web" | "headless"
