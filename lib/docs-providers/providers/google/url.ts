/**
 * Google Workspace document URL recognition. Pure — the composer calls it on
 * every keystroke.
 *
 * Only the two kinds this provider can read are matched. A `drive.google.com/
 * file/d/<id>` link is deliberately NOT matched: its kind is unknowable without
 * a metadata round-trip, and `matchRef` must stay synchronous, so offering it
 * would mean showing the user a picker row that can only fail at fetch time.
 */

import type { RemoteDocKind } from "@/lib/docs-providers/types"

/** Google file ids are base64url-ish and comfortably long. */
const FILE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/

const PATH_KINDS: Record<string, RemoteDocKind> = {
  document: "doc",
  spreadsheets: "sheet",
}

export interface GoogleDocRef {
  kind: RemoteDocKind
  id: string
}

/**
 * Parse a Google Docs / Sheets URL.
 *
 * Recognized shapes (the optional `u/<n>` account segment is tolerated):
 *   - `https://docs.google.com/document/d/<id>/edit`
 *   - `https://docs.google.com/document/u/0/d/<id>`
 *   - `https://docs.google.com/spreadsheets/d/<id>/edit#gid=0`
 *
 * Returns `null` for anything else — including presentations, forms, and bare
 * ids (a bare Google file id is indistinguishable from arbitrary text).
 */
export function parseGoogleDocUrl(input: string): GoogleDocRef | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.hostname.toLowerCase() !== "docs.google.com") return null

  const segments = url.pathname.split("/").filter(Boolean)
  const kind = PATH_KINDS[segments[0]]
  if (!kind) return null

  const dIndex = segments.indexOf("d", 1)
  if (dIndex === -1) return null
  const id = segments[dIndex + 1]
  if (!id || !FILE_ID_RE.test(id)) return null
  return { kind, id }
}

/** Canonical web URL for a ref, used for the composer chip's link. */
export function googleDocUrl(kind: RemoteDocKind, id: string): string {
  const segment = kind === "sheet" ? "spreadsheets" : "document"
  return `https://docs.google.com/${segment}/d/${id}/edit`
}
