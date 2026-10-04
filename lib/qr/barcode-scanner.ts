"use client"

import { scan, type BarcodeScannerLoader, type ScanOutcome } from "@/lib/capacitor/barcode"

export type { BarcodeScannerLoader, ScanOutcome } from "@/lib/capacitor/barcode"

export interface ScanQrOptions {
  loader?: BarcodeScannerLoader
}

/** Backward-compatible QR facade using the canonical native scan flow. */
export function scanQrCode(opts: ScanQrOptions = {}): Promise<ScanOutcome> {
  return scan({ ...opts, formats: ["QR_CODE"] })
}
