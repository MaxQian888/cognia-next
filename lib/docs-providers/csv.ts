/**
 * Grid → CSV rendering for remote spreadsheet-shaped documents.
 *
 * The existing CSV exporters in this repo (`lib/connectors/audit-export.ts`,
 * `lib/telemetry/inbox-telemetry-export.ts`, `lib/ai/eval/export.ts`) each
 * serialize ONE known row type through a private escape helper. A remote
 * spreadsheet has no known row type — it is an untyped 2-D grid, and one
 * document can hold several of them (worksheets, Bitable tables). So this
 * module owns that shape instead of adding a fourth private escaper.
 *
 * RFC 4180 escaping: quote when the cell contains a comma, quote, CR or LF;
 * double any embedded quote.
 */

export interface CsvSection {
  /** Worksheet / table name, rendered as a `## <title>` heading above the rows. */
  title: string
  /** Row-major cells. Ragged rows are fine — they are emitted as-is. */
  rows: readonly (readonly unknown[])[]
  /** Appended under the section when this section itself was capped. */
  note?: string
}

/** Escape one cell for CSV. `null` / `undefined` become the empty string. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** Render one row. */
export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(",")
}

/**
 * Render sections into a single body. Multi-section documents get `## <title>`
 * headings so the model can tell the worksheets apart; a single unnamed
 * section renders as bare CSV.
 */
export function renderCsvSections(sections: readonly CsvSection[]): string {
  if (sections.length === 0) return ""
  if (sections.length === 1 && !sections[0].title && !sections[0].note) {
    return sections[0].rows.map(csvRow).join("\n")
  }
  return sections
    .map((section) => {
      const parts: string[] = []
      if (section.title) parts.push(`## ${section.title}`)
      parts.push(section.rows.map(csvRow).join("\n"))
      if (section.note) parts.push(section.note)
      return parts.join("\n")
    })
    .join("\n\n")
}
