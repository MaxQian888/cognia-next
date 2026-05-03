/**
 * Stub: helpers around `lib/native/model-download.ts`. Cognia uses these
 * to format byte sizes / ETAs and to derive UI states; cognia-next ships
 * a minimal version sufficient for the ported provider components.
 */

import type { ModelDownloadProgress } from "./model-download"

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function deriveDownloadLabel(progress: ModelDownloadProgress | undefined): string {
  if (!progress) return ""
  switch (progress.status) {
    case "pending":
      return "Queued"
    case "downloading":
      return `${progress.percentage.toFixed(0)}%`
    case "completed":
      return "Installed"
    case "cancelled":
      return "Cancelled"
    case "error":
      return progress.error ? `Error: ${progress.error}` : "Error"
    default:
      return ""
  }
}

export function isDownloadInFlight(progress: ModelDownloadProgress | undefined): boolean {
  return progress?.status === "pending" || progress?.status === "downloading"
}
