/**
 * What an address typed into a desktop browser pane should load (ADR-0201).
 *
 * Besides web addresses the bar accepts absolute paths and `file://` URLs:
 *
 * - The embedded webview cannot script a `file://` origin, so a local path is
 *   served by Rust's loopback static server (`browser_local_file_serve`), which
 *   keeps relative assets working and lands the page in the trusted tier.
 * - Local / user Chromium open `file://` directly (the session is created with
 *   `allowFileUrls`), except for a `~/` path, which only Rust can expand, and a
 *   UNC share, which Chromium's file loader does not reach reliably: both go
 *   through the same static server.
 */

import { localPathFromAddress, serveLocalFile } from "@/lib/browser/local-content-client"
import { normalizePreviewUrl } from "@/lib/browser/protocol"

export type AddressTarget = "embedded" | "chromium"

export type ResolvedAddress =
  | { kind: "url"; url: string; local: boolean }
  | { kind: "invalid" }
  | { kind: "error"; message: string }

/** A filesystem path as a `file://` URL, percent-encoding each segment. */
export function pathToFileUrl(path: string): string {
  const slashed = path.replace(/\\/g, "/")
  const withRoot = /^[a-zA-Z]:\//.test(slashed) ? `/${slashed}` : slashed
  const encoded = withRoot
    .split("/")
    .map((segment, index) =>
      // Keep the drive letter's colon readable (`/C:/…`), as browsers write it.
      index === 1 && /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)
    )
    .join("/")
  return `file://${encoded}`
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return String(error)
}

export async function resolveBrowserAddress(
  input: string,
  target: AddressTarget
): Promise<ResolvedAddress> {
  const path = localPathFromAddress(input)
  if (path) {
    const needsServer = target === "embedded" || path.startsWith("~") || path.startsWith("//")
    if (!needsServer) {
      return {
        kind: "url",
        url: /^file:\/\//i.test(input.trim()) ? input.trim() : pathToFileUrl(path),
        local: true,
      }
    }
    try {
      const served = await serveLocalFile(path)
      return { kind: "url", url: served.url, local: true }
    } catch (error) {
      return { kind: "error", message: errorMessage(error) }
    }
  }
  const url = normalizePreviewUrl(input)
  return url ? { kind: "url", url, local: false } : { kind: "invalid" }
}
