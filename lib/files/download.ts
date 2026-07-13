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
 */

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
): void {
  const blob = new Blob([content], { type: mimeType })
  downloadBlob(blob, filename)
}

/** Download an arbitrary Blob as a file (e.g., SVG export, fetched image). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  try {
    clickAnchor(url, filename)
  } finally {
    URL.revokeObjectURL(url)
  }
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
): Promise<void> {
  if (options.fetchAsBlob) {
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`)
    }
    const blob = await res.blob()
    downloadBlob(blob, filename)
    return
  }
  clickAnchor(url, filename)
}
