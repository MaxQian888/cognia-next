/**
 * Feishu 多维表格 (Bitable) reader for the remote-document providers.
 *
 * A Bitable "app" is a container of tables, so reading one is three calls:
 *   - `GET  /open-apis/bitable/v1/apps/{app}`                        → name
 *   - `GET  /open-apis/bitable/v1/apps/{app}/tables`                 → tables
 *   - `POST /open-apis/bitable/v1/apps/{app}/tables/{id}/records/search` → rows
 *
 * `records/search` (not `records/list`) is used because it is the endpoint that
 * still accepts an empty filter and returns display-ready field values.
 *
 * Field values are heterogeneous — text, numbers, arrays of link objects,
 * attachment descriptors. `csvCell` JSON-encodes anything non-scalar rather
 * than flattening it, so nothing is silently lost; the model can still read the
 * structure. Column order is taken from the first record's key order and then
 * held fixed, so a record missing a field lands in the right column instead of
 * shifting every later cell.
 */

import { MAX_BITABLE_ROWS, MAX_BITABLE_TABLES, truncationMarker } from "@/lib/docs-providers/limits"
import { renderCsvSections, type CsvSection } from "@/lib/docs-providers/csv"
import type { LarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"

interface BitableAppResponse {
  app?: { name?: string }
}

interface BitableTablesResponse {
  items?: { table_id?: string; name?: string }[]
  has_more?: boolean
}

interface BitableRecordsResponse {
  items?: { record_id?: string; fields?: Record<string, unknown> }[]
  has_more?: boolean
}

export interface LarkBitableRead {
  title: string
  text: string
  truncated: boolean
}

/**
 * Build a stable column list across records: first-seen order, so the header
 * reflects the table's own field order for the common case where every record
 * carries every field.
 */
export function bitableColumns(records: readonly { fields?: Record<string, unknown> }[]): string[] {
  const seen = new Set<string>()
  for (const record of records) {
    for (const key of Object.keys(record.fields ?? {})) seen.add(key)
  }
  return [...seen]
}

/** Read a Feishu Bitable app as one CSV section per table. */
export async function readLarkBitable(
  api: LarkAuthedApi,
  appToken: string
): Promise<LarkBitableRead> {
  const encoded = encodeURIComponent(appToken)
  const [app, tables] = await Promise.all([
    api.get<BitableAppResponse>(`/open-apis/bitable/v1/apps/${encoded}`),
    api.get<BitableTablesResponse>(
      `/open-apis/bitable/v1/apps/${encoded}/tables?page_size=${MAX_BITABLE_TABLES}`
    ),
  ])

  const items = (tables.items ?? []).filter((table) => table.table_id)
  const selected = items.slice(0, MAX_BITABLE_TABLES)
  let truncated = Boolean(tables.has_more) || selected.length < items.length

  const sections: CsvSection[] = []
  for (const table of selected) {
    const response = await api.post<BitableRecordsResponse>(
      `/open-apis/bitable/v1/apps/${encoded}/tables/${encodeURIComponent(
        table.table_id as string
      )}/records/search?page_size=${MAX_BITABLE_ROWS}`,
      {}
    )
    const records = response.items ?? []
    const columns = bitableColumns(records)
    const rows: unknown[][] = [columns, ...records.map((r) => columns.map((c) => r.fields?.[c]))]
    const tableTruncated = Boolean(response.has_more)
    if (tableTruncated) truncated = true
    sections.push({
      title: table.name ?? (table.table_id as string),
      rows,
      note: tableTruncated
        ? truncationMarker(
            `table “${table.name ?? table.table_id}”`,
            MAX_BITABLE_ROWS,
            "records"
          ).trim()
        : undefined,
    })
  }

  let text = renderCsvSections(sections)
  if (selected.length < items.length || tables.has_more) {
    text += truncationMarker("this Bitable app", MAX_BITABLE_TABLES, "tables")
  }
  return { title: app.app?.name ?? appToken, text, truncated }
}
