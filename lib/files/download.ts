/**
 * Browser-side file download helpers.
 *
 * Live in `lib/files/` (alongside other file-system helpers) rather than
 * `lib/agent/utils.ts` because they depend on `document` / `URL.createObjectURL`
 * and are not agent-specific.
 *
 * All helpers throw synchronously when invoked outside a DOM context (e.g.,
 * during SSR or in a Tauri main-process runtime). Callers should gate by
 * `typeof window !== "undefined"` before calling.
 *
 * Inside the Capacitor mobile shell an `<a download>` click is a silent no-op:
 * the Android WebView has no download manager wired to `blob:` URLs, so every
 * "Download" button produced no file and no error. There the file is instead
 * handed to the native share sheet (staged in the app cache), where the user
 * picks a destination such as Files / Drive / a chat. Callers that want a
 * persistent save with location feedback should use `saveExport` +
 * `notifyExportOutcome`; these helpers are the fallback for every other
 * download affordance.
 */

import { loggers } from "@cognia/logging"
import { shareContent } from "@/lib/capacitor/share"
import { isCapacitor } from "@/lib/platform/detect"

/**
 * - `downloaded` — the browser download was triggered (web / Tauri).
 * - `shared`     — mobile: the file went out through the native share sheet.
 * - `cancelled`  — mobile: the user dismissed the share sheet.
 * - `error`      — mobile: the file could not be staged or shared.
 */
export type DownloadOutcome =
  | { kind: "downloaded" }
  | { kind: "shared" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string }

async function handOffToNativeShare(blob: Blob, filename: string): Promise<DownloadOutcome> {
  const file = new File([blob], filename, { type: blob.type || "application/octet-stream" })
  const out = await shareContent({ files: [file], title: filename, dialogTitle: filename })
  if (out.kind === "shared") return { kind: "shared" }
  if (out.kind === "cancelled") return { kind: "cancelled" }
  const message = out.kind === "error" ? out.message : "native share is unavailable"
  loggers.ui.warn("download: mobile hand-off failed", { filename, error: message })
  return { kind: "error", message }
}

function clickAnchor(href: string, filename: string): void {
  const a = document.createElement("a")
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/** Download a string payload as a file. */
export function downloadFile(
  filename: string,
  content: string,
  mimeType: string = "text/plain"
): Promise<DownloadOutcome> {
  const blob = new Blob([content], { type: mimeType })
  return downloadBlob(blob, filename)
}

/**
 * Download an arbitrary Blob as a file (e.g., SVG export, fetched image).
 *
 * On web / Tauri the anchor click happens synchronously (a throw still reaches
 * the caller's `try`); the returned promise is already resolved. On mobile the
 * file goes to the native share sheet and the promise settles with the result.
 */
export function downloadBlob(blob: Blob, filename: string): Promise<DownloadOutcome> {
  if (isCapacitor()) return handOffToNativeShare(blob, filename)
  const url = URL.createObjectURL(blob)
  try {
    clickAnchor(url, filename)
  } finally {
    URL.revokeObjectURL(url)
  }
  return Promise.resolve({ kind: "downloaded" })
}

/**
 * Copy an image (or any) Blob to the system clipboard. Returns true on success,
 * false when the platform lacks async-clipboard image support (Firefox, some
 * Tauri/webview builds) — callers should keep a "download" fallback. Never
 * throws for the unsupported case; only a genuine write failure rejects.
 */
export async function copyBlobToClipboard(blob: Blob): Promise<boolean> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined
  if (!clipboard || typeof clipboard.write !== "function" || typeof ClipboardItem === "undefined") {
    return false
  }
  await clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })])
  return true
}

/**
 * Trigger a download from a remote URL. If `fetchAsBlob` is true (the default for
 * cross-origin or hashed assets that wouldn't honor the `download` attribute),
 * the asset is fetched first and saved via {@link downloadBlob}. Otherwise the
 * URL is used directly as the anchor href — appropriate for same-origin static
 * media (audio/video) where bandwidth-doubling is wasteful.
 */
export async function downloadFromUrl(
  url: string,
  filename: string,
  options: { fetchAsBlob?: boolean } = {}
): Promise<DownloadOutcome> {
  // A bare anchor never downloads inside the mobile WebView, so the asset is
  // always fetched there and handed to the native share sheet.
  if (options.fetchAsBlob || isCapacitor()) {
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`)
    }
    const blob = await res.blob()
    return downloadBlob(blob, filename)
  }
  clickAnchor(url, filename)
  return { kind: "downloaded" }
}
