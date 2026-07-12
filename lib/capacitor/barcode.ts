"use client"

import { makeDefaultLoader } from "./_shared"

/**
 * Barcode/QR scan via `@capacitor-mlkit/barcode-scanning`.
 *
 * Re-shapes the existing `lib/qr/barcode-scanner.ts` (M4.5 stub) into the
 * `lib/capacitor/*` pattern. The legacy module is kept for backward
 * compatibility; new code should import from this file.
 */

export type ScanOutcome =
  | { kind: "scanned"; raw: string }
  | { kind: "permission_denied" }
  | { kind: "cancelled" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

interface ModuleInstallProgressEvent {
  /** GoogleBarcodeScannerModuleInstallState (see constants below). */
  state: number
  progress?: number
}

interface BarcodeScannerShape {
  requestPermissions(): Promise<{
    camera: "granted" | "denied" | "limited" | "prompt" | "prompt-with-rationale"
  }>
  checkPermissions(): Promise<{
    camera: "granted" | "denied" | "limited" | "prompt" | "prompt-with-rationale"
  }>
  scan(opts?: { formats?: string[] }): Promise<{ barcodes: Array<{ rawValue: string }> }>
  isSupported(): Promise<{ supported: boolean }>
  // Android-only: the native scan UI depends on the on-demand Google Barcode
  // Scanner module, which is absent on a fresh install until downloaded.
  isGoogleBarcodeScannerModuleAvailable?(): Promise<{ available: boolean }>
  installGoogleBarcodeScannerModule?(): Promise<void>
  addListener?(
    event: "googleBarcodeScannerModuleInstallProgress",
    cb: (e: ModuleInstallProgressEvent) => void
  ): Promise<{ remove: () => Promise<void> }>
}

// GoogleBarcodeScannerModuleInstallState enum values (from
// @capacitor-mlkit/barcode-scanning). Kept as literals so we don't import the
// native package (absent from the web bundle).
const MODULE_STATE_CANCELED = 3
const MODULE_STATE_COMPLETED = 4
const MODULE_STATE_FAILED = 5

export type BarcodeScannerLoader = () => Promise<BarcodeScannerShape>

// Resolve through the shared global-aware loader: on device the plugin proxy
// lives at `window.Capacitor.Plugins.BarcodeScanner` (populated by
// `registerNativePlugins()` at boot — see `register-plugins.ts`). The previous
// bare `import("@capacitor-mlkit/barcode-scanning")` could never resolve on
// device (mobile-workspace dep, not bundled), so QR-scan pairing silently
// reported `unsupported`.
const defaultLoader: BarcodeScannerLoader = makeDefaultLoader<BarcodeScannerShape>(
  "@capacitor-mlkit/barcode-scanning",
  "BarcodeScanner"
)

export interface ScanOptions {
  formats?: string[]
  loader?: BarcodeScannerLoader
}

/** Runtime Capacitor platform ("android" | "ios" | "web" | undefined). */
function capacitorPlatform(): string | undefined {
  return (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.()
}

/**
 * On Android the native scan UI needs the Google Barcode Scanner module, which
 * ships on-demand: on a fresh device `scan()` rejects with `MODULE_UNAVAILABLE`
 * until it downloads. Ensure it's present first — check availability, and if
 * missing kick off the install and await the completion event.
 *
 * Resolves once the module is ready; rejects if the install fails or is
 * canceled (e.g. a device without Google Play Services). No-op on iOS/web or
 * when the loaded plugin predates these methods.
 */
async function ensureGoogleModule(scanner: BarcodeScannerShape): Promise<void> {
  if (capacitorPlatform() !== "android") return
  if (
    typeof scanner.isGoogleBarcodeScannerModuleAvailable !== "function" ||
    typeof scanner.installGoogleBarcodeScannerModule !== "function"
  ) {
    return
  }
  const { available } = await scanner.isGoogleBarcodeScannerModuleAvailable()
  if (available) return

  await new Promise<void>((resolve, reject) => {
    let handle: { remove: () => Promise<void> } | undefined
    const cleanup = () => void handle?.remove().catch(() => {})
    const onProgress = (e: ModuleInstallProgressEvent) => {
      if (e.state === MODULE_STATE_COMPLETED) {
        cleanup()
        resolve()
      } else if (e.state === MODULE_STATE_FAILED || e.state === MODULE_STATE_CANCELED) {
        cleanup()
        reject(new Error(`barcode module install failed (state ${e.state})`))
      }
    }
    const start = scanner.addListener
      ? scanner.addListener("googleBarcodeScannerModuleInstallProgress", onProgress)
      : Promise.resolve(undefined)
    start
      .then((h) => {
        handle = h
        return scanner.installGoogleBarcodeScannerModule!()
      })
      // If there is no progress listener support, install() resolving means the
      // request was accepted; treat that as done so we don't hang forever.
      .then(() => {
        if (!scanner.addListener) resolve()
      })
      .catch(reject)
  })
}

export async function scan(opts: ScanOptions = {}): Promise<ScanOutcome> {
  const { formats = ["QR_CODE"], loader = defaultLoader } = opts

  let scanner: BarcodeScannerShape
  try {
    scanner = await loader()
  } catch {
    return { kind: "unsupported" }
  }

  try {
    const support = await scanner.isSupported()
    if (!support.supported) return { kind: "unsupported" }

    let perm = await scanner.checkPermissions()
    if (perm.camera !== "granted" && perm.camera !== "limited") {
      perm = await scanner.requestPermissions()
    }
    if (perm.camera !== "granted" && perm.camera !== "limited") {
      return { kind: "permission_denied" }
    }

    // Android: make sure the on-demand Google Barcode Scanner module is
    // installed, else the first scan on a fresh device rejects with
    // MODULE_UNAVAILABLE. A device with no Google Play Services (throws/rejects
    // here) surfaces as an `error` outcome rather than a confusing native crash.
    await ensureGoogleModule(scanner)

    const result = await scanner.scan({ formats })
    const first = result.barcodes[0]
    if (!first || !first.rawValue) return { kind: "cancelled" }
    return { kind: "scanned", raw: first.rawValue }
  } catch (err: unknown) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
