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

interface BarcodeScannerShape {
  requestPermissions(): Promise<{
    camera: "granted" | "denied" | "limited" | "prompt" | "prompt-with-rationale"
  }>
  checkPermissions(): Promise<{
    camera: "granted" | "denied" | "limited" | "prompt" | "prompt-with-rationale"
  }>
  scan(opts?: { formats?: string[] }): Promise<{ barcodes: Array<{ rawValue: string }> }>
  isSupported(): Promise<{ supported: boolean }>
}

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
