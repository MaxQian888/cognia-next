/**
 * Google Drive / Sheets read calls for the document provider.
 *
 * Two APIs are needed, not one:
 *   - Drive `files.list` for search and `files.export` for a Doc body (Drive is
 *     the only API that renders a Doc as markdown);
 *   - Sheets `spreadsheets.values.batchGet` for a workbook, because Drive's CSV
 *     export silently returns only the FIRST worksheet — exactly the kind of
 *     quiet truncation this subsystem refuses to ship.
 *
 * Every failure becomes a `DocsProviderError` here, so the provider's own code
 * never inspects an HTTP status.
 */

import {
  MAX_SHEET_COLS,
  MAX_SHEET_ROWS,
  MAX_SHEET_TABS,
  truncationMarker,
} from "@/lib/docs-providers/limits"
import { renderCsvSections, type CsvSection } from "@/lib/docs-providers/csv"
import { DocsProviderError, type RemoteDocRef } from "@/lib/docs-providers/types"
import { columnLetters } from "@/lib/docs-providers/providers/lark/a1"
import { googleDocUrl } from "./url"
import { parseJson, type GoogleHttpFn, type GoogleHttpResponse } from "./http"

export const DRIVE_API = "https://www.googleapis.com/drive/v3"
export const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"

export const DOC_MIME = "application/vnd.google-apps.document"
export const SHEET_MIME = "application/vnd.google-apps.spreadsheet"

/** Preferred Doc export format; Google added markdown in 2024. */
export const DOC_EXPORT_MIME = "text/markdown"
export const DOC_EXPORT_FALLBACK_MIME = "text/plain"

export interface GoogleApiContext {
  http: GoogleHttpFn
  accessToken: string
  signal?: AbortSignal
}

/** Map a Google HTTP failure onto the provider taxonomy. */
export function mapGoogleStatus(response: GoogleHttpResponse): DocsProviderError {
  const parsed = parseJson<{ error?: { message?: string; status?: string } }>(response.body)
  const reason = parsed?.error?.message ?? `Google returned HTTP ${response.status}`
  switch (response.status) {
    case 401:
      return new DocsProviderError("notAuthorized", { reason })
    case 403:
      // Google uses 403 for both "no access to this file" and quota exhaustion;
      // the machine-readable status disambiguates.
      return parsed?.error?.status === "RESOURCE_EXHAUSTED"
        ? new DocsProviderError("rateLimited", { reason })
        : new DocsProviderError("noPermission", { reason })
    case 404:
      return new DocsProviderError("notFound", { reason })
    case 429:
      return new DocsProviderError("rateLimited", { reason })
    default:
      return new DocsProviderError("network", { reason })
  }
}

async function call(ctx: GoogleApiContext, url: string): Promise<GoogleHttpResponse> {
  const response = await ctx.http({
    url,
    method: "GET",
    headers: { Authorization: `Bearer ${ctx.accessToken}` },
  })
  if (response.status >= 400) throw mapGoogleStatus(response)
  return response
}

async function callJson<T>(ctx: GoogleApiContext, url: string): Promise<T> {
  const response = await call(ctx, url)
  const parsed = parseJson<T>(response.body)
  if (!parsed) {
    throw new DocsProviderError("network", { reason: "Google returned a non-JSON body" })
  }
  return parsed
}

/**
 * Escape a user string for a Drive `q` term. Drive uses single-quoted literals
 * with backslash escaping — an unescaped quote would let the query text change
 * the filter's structure.
 */
export function escapeDriveQueryLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")
}

interface DriveFile {
  id?: string
  name?: string
  mimeType?: string
  modifiedTime?: string
}

/** Search the user's Drive for readable Docs and Sheets. */
export async function searchGoogleDocs(
  ctx: GoogleApiContext,
  query: string,
  limit: number
): Promise<RemoteDocRef[]> {
  const clauses = [
    `name contains '${escapeDriveQueryLiteral(query)}'`,
    "trashed = false",
    `(mimeType = '${DOC_MIME}' or mimeType = '${SHEET_MIME}')`,
  ]
  const params = new URLSearchParams({
    q: clauses.join(" and "),
    fields: "files(id,name,mimeType,modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: String(Math.min(Math.max(1, limit), 100)),
    // Without these two the call is blind to Shared drives, which is where most
    // real work documents live.
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  })
  const data = await callJson<{ files?: DriveFile[] }>(ctx, `${DRIVE_API}/files?${params}`)
  const out: RemoteDocRef[] = []
  for (const file of data.files ?? []) {
    if (!file.id) continue
    const kind = file.mimeType === SHEET_MIME ? "sheet" : file.mimeType === DOC_MIME ? "doc" : null
    if (!kind) continue
    const updatedAtMs = file.modifiedTime ? Date.parse(file.modifiedTime) : NaN
    out.push({
      providerId: "google",
      kind,
      id: file.id,
      title: file.name?.trim() || file.id,
      url: googleDocUrl(kind, file.id),
      ...(Number.isFinite(updatedAtMs) ? { updatedAtMs } : {}),
    })
  }
  return out
}

/** File name, used when a ref arrived from a pasted URL and has no title. */
export async function getGoogleFileName(ctx: GoogleApiContext, id: string): Promise<string> {
  const data = await callJson<{ name?: string }>(
    ctx,
    `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=name&supportsAllDrives=true`
  )
  return data.name?.trim() || id
}

export interface GoogleDocRead {
  text: string
  format: "markdown" | "text"
}

/**
 * Export a Doc body. Markdown first; a Google deployment that does not offer it
 * answers 400, so plain text is the documented fallback rather than a failure.
 */
export async function exportGoogleDoc(ctx: GoogleApiContext, id: string): Promise<GoogleDocRead> {
  const url = (mime: string) =>
    `${DRIVE_API}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(mime)}&supportsAllDrives=true`
  const response = await ctx.http({
    url: url(DOC_EXPORT_MIME),
    method: "GET",
    headers: { Authorization: `Bearer ${ctx.accessToken}` },
  })
  if (response.status < 400) return { text: response.body, format: "markdown" }
  if (response.status !== 400) throw mapGoogleStatus(response)
  const fallback = await call(ctx, url(DOC_EXPORT_FALLBACK_MIME))
  return { text: fallback.body, format: "text" }
}

interface SheetProperties {
  properties?: {
    title?: string
    sheetId?: number
    hidden?: boolean
    gridProperties?: { rowCount?: number; columnCount?: number }
  }
}

export interface GoogleSheetRead {
  title: string
  text: string
  truncated: boolean
}

/**
 * Read a spreadsheet as sectioned CSV.
 *
 * Hidden worksheets are skipped for the same reason as the Feishu reader: they
 * are hidden from the user, so feeding them to a model shows more than opening
 * the link would.
 */
export async function readGoogleSpreadsheet(
  ctx: GoogleApiContext,
  id: string
): Promise<GoogleSheetRead> {
  const encoded = encodeURIComponent(id)
  const meta = await callJson<{ properties?: { title?: string }; sheets?: SheetProperties[] }>(
    ctx,
    `${SHEETS_API}/${encoded}?fields=properties.title,sheets.properties`
  )
  const visible = (meta.sheets ?? [])
    .map((sheet) => sheet.properties)
    .filter(
      (props): props is NonNullable<SheetProperties["properties"]> =>
        Boolean(props?.title) && props?.hidden !== true
    )
  const selected = visible.slice(0, MAX_SHEET_TABS)
  let truncated = selected.length < visible.length

  const sections: CsvSection[] = []
  if (selected.length > 0) {
    const params = new URLSearchParams({ majorDimension: "ROWS" })
    for (const props of selected) {
      const rows = Math.min(props.gridProperties?.rowCount ?? MAX_SHEET_ROWS, MAX_SHEET_ROWS)
      const cols = Math.min(props.gridProperties?.columnCount ?? MAX_SHEET_COLS, MAX_SHEET_COLS)
      // A1 ranges quote the sheet title; an embedded quote is doubled.
      const title = (props.title as string).replaceAll("'", "''")
      params.append(
        "ranges",
        `'${title}'!A1:${columnLetters(Math.max(1, cols))}${Math.max(1, rows)}`
      )
    }
    const values = await callJson<{ valueRanges?: { values?: unknown[][] }[] }>(
      ctx,
      `${SHEETS_API}/${encoded}/values:batchGet?${params}`
    )
    selected.forEach((props, index) => {
      const overflowed =
        (props.gridProperties?.rowCount ?? 0) > MAX_SHEET_ROWS ||
        (props.gridProperties?.columnCount ?? 0) > MAX_SHEET_COLS
      if (overflowed) truncated = true
      sections.push({
        title: props.title as string,
        rows: values.valueRanges?.[index]?.values ?? [],
        note: overflowed
          ? truncationMarker(
              `worksheet “${props.title}”`,
              MAX_SHEET_ROWS,
              `rows × ${MAX_SHEET_COLS} columns`
            ).trim()
          : undefined,
      })
    })
  }

  let text = renderCsvSections(sections)
  if (selected.length < visible.length) {
    text += truncationMarker("this spreadsheet", MAX_SHEET_TABS, "worksheets")
  }
  return { title: meta.properties?.title ?? id, text, truncated }
}
