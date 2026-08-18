/**
 * Feishu 电子表格 (spreadsheet) reader for the remote-document providers.
 *
 * Two calls per workbook plus one per worksheet:
 *   - `GET /open-apis/sheets/v3/spreadsheets/{token}`               → title
 *   - `GET /open-apis/sheets/v3/spreadsheets/{token}/sheets/query`  → worksheets
 *   - `GET /open-apis/sheets/v2/spreadsheets/{token}/values/{range}` → cells
 *
 * The values endpoint is still v2 — v3 has no bulk range read — and it takes an
 * A1 range, hence `./a1`. Hidden worksheets are skipped: they are hidden from
 * the user, so silently feeding them to a model would leak more than the user
 * sees when they open the same link.
 *
 * Caps come from `lib/docs-providers/limits.ts` and are always paired with a
 * visible in-body marker; nothing here truncates silently.
 */

import {
  MAX_SHEET_COLS,
  MAX_SHEET_ROWS,
  MAX_SHEET_TABS,
  truncationMarker,
} from "@/lib/docs-providers/limits"
import { renderCsvSections, type CsvSection } from "@/lib/docs-providers/csv"
import type { LarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import { sheetRange } from "./a1"

interface SheetMetaResponse {
  spreadsheet?: { title?: string; url?: string }
}

interface SheetQueryResponse {
  sheets?: {
    sheet_id?: string
    title?: string
    hidden?: boolean
    grid_properties?: { row_count?: number; column_count?: number }
  }[]
}

interface ValuesResponse {
  valueRange?: { values?: unknown[][] }
}

export interface LarkSheetRead {
  title: string
  /** CSV body: one `## <worksheet>` section per visible worksheet. */
  text: string
  truncated: boolean
}

/** Read a Feishu spreadsheet as sectioned CSV. */
export async function readLarkSpreadsheet(
  api: LarkAuthedApi,
  token: string
): Promise<LarkSheetRead> {
  const encoded = encodeURIComponent(token)
  const [meta, query] = await Promise.all([
    api.get<SheetMetaResponse>(`/open-apis/sheets/v3/spreadsheets/${encoded}`),
    api.get<SheetQueryResponse>(`/open-apis/sheets/v3/spreadsheets/${encoded}/sheets/query`),
  ])

  const visible = (query.sheets ?? []).filter((sheet) => sheet.hidden !== true && sheet.sheet_id)
  const selected = visible.slice(0, MAX_SHEET_TABS)
  let truncated = selected.length < visible.length

  const sections: CsvSection[] = []
  for (const sheet of selected) {
    const rowCount = Math.min(sheet.grid_properties?.row_count ?? MAX_SHEET_ROWS, MAX_SHEET_ROWS)
    const colCount = Math.min(sheet.grid_properties?.column_count ?? MAX_SHEET_COLS, MAX_SHEET_COLS)
    const range = sheetRange(sheet.sheet_id as string, rowCount, colCount)
    const values = await api.get<ValuesResponse>(
      `/open-apis/sheets/v2/spreadsheets/${encoded}/values/${encodeURIComponent(range)}`
    )
    const rows = values.valueRange?.values ?? []
    const sheetTruncated =
      (sheet.grid_properties?.row_count ?? 0) > MAX_SHEET_ROWS ||
      (sheet.grid_properties?.column_count ?? 0) > MAX_SHEET_COLS
    if (sheetTruncated) truncated = true
    sections.push({
      title: sheet.title ?? (sheet.sheet_id as string),
      rows,
      note: sheetTruncated
        ? truncationMarker(
            `worksheet “${sheet.title ?? sheet.sheet_id}”`,
            MAX_SHEET_ROWS,
            `rows × ${MAX_SHEET_COLS} columns`
          ).trim()
        : undefined,
    })
  }

  let text = renderCsvSections(sections)
  if (selected.length < visible.length) {
    text += truncationMarker("this spreadsheet", MAX_SHEET_TABS, "worksheets")
  }
  return { title: meta.spreadsheet?.title ?? token, text, truncated }
}
