"use client"

/**
 * Thin facade over `@capacitor-mlkit/barcode-scanning` (M4.5 / #49).
 *
 * Two purposes:
 *   1. Hide the dynamic import behind a function so the web bundle never
 *      tries to resolve the native plugin.
 *   2. Normalize the plugin's return shape into a single `string | null`
 *      so the caller stays platform-agnostic.
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

const defaultLoader: BarcodeScannerLoader = async () => {
  // Avoid static analysis so the web bundle skips the native module.
  const moduleId = "@capacitor-mlkit/barcode-scanning"
  const mod = (await import(/* webpackIgnore: true */ moduleId)) as {
    BarcodeScanner: BarcodeScannerShape
  }
  return mod.BarcodeScanner
}

export interface ScanQrOptions {
  loader?: BarcodeScannerLoader
}

/**
 * Run the QR scan flow. On success returns `{ kind: "scanned", raw }`.
 * Permission denial / device unsupported / cancellation each have their
 * own kind so the UI can render an actionable hint.
 */
export async function scanQrCode(opts: ScanQrOptions = {}): Promise<ScanOutcome> {
  let scanner: BarcodeScannerShape
  try {
    scanner = await (opts.loader ?? defaultLoader)()
  } catch {
    // The dynamic-import rejects in the web bundle; surface that as
    // "this feature only works on the mobile shell".
    return { kind: "unsupported" }
  }

  try {
    const support = await scanner.isSupported()
    if (!support.supported) {
      return { kind: "unsupported" }
    }

    let perm = await scanner.checkPermissions()
    if (perm.camera !== "granted") {
      perm = await scanner.requestPermissions()
    }
    if (perm.camera !== "granted" && perm.camera !== "limited") {
      return { kind: "permission_denied" }
    }

    const result = await scanner.scan({ formats: ["QR_CODE"] })
    const first = result.barcodes[0]
    if (!first || !first.rawValue) {
      return { kind: "cancelled" }
    }
    return { kind: "scanned", raw: first.rawValue }
  } catch (err: unknown) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
