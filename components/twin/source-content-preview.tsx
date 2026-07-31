"use client"

/**
 * Shared source-content preview body — tables + capped text.
 *
 * Extracted from `twin-source-preview-dialog.tsx` so both the post-add
 * preview dialog and the add-source flow's review step render the same
 * thing: any tables detected inside the text via
 * `@cognia/document/table-extractor` (copy-as-markdown per table), then the
 * body capped at `MAX_PREVIEW_CHARS`. The heavy `extractTables` pass is
 * gated on `active` so list surfaces that mount many previews stay cheap
 * while hidden.
 */

import { useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { CopyIcon, CheckIcon } from "lucide-react"
import {
  extractTables,
  normalizeTable,
  getTableStats,
  tableToMarkdown,
  type ExtractedTable,
} from "@cognia/document/table-extractor"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/** Cap the rendered source body so a multi-MB source can't freeze the UI. */
export const MAX_PREVIEW_CHARS = 20_000
/** Cap rendered rows per table — a CSV source can carry thousands. */
const MAX_PREVIEW_ROWS = 50

export interface SourceContentPreviewProps {
  /** The source body to preview. */
  text: string
  /** Gate for the table-extraction pass; pass the dialog's `open` state. */
  active: boolean
  /** Height class for the body scroll area (defaults to `h-64`). */
  bodyHeightClassName?: string
}

export function SourceContentPreview({
  text,
  active,
  bodyHeightClassName = "h-64",
}: SourceContentPreviewProps) {
  const t = useTranslations("twin.sources")

  // Only pay for extraction while visible — callers may mount many previews.
  const tables = useMemo<ExtractedTable[]>(
    () => (active ? extractTables(text).tables.map((table) => normalizeTable(table)) : []),
    [active, text]
  )

  const truncatedBody = text.length > MAX_PREVIEW_CHARS ? text.slice(0, MAX_PREVIEW_CHARS) : text
  const bodyTruncated = text.length > MAX_PREVIEW_CHARS

  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleCopy = async (table: ExtractedTable, index: number) => {
    try {
      await navigator.clipboard?.writeText(tableToMarkdown(table))
      setCopiedIndex(index)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopiedIndex(null), 1500)
    } catch {
      // Clipboard unavailable / denied — silently no-op; the markdown is
      // still visible in the rendered table.
    }
  }

  return (
    <>
      <section className="flex flex-col gap-2" data-testid="twin-source-preview-tables">
        <h3 className="text-sm font-medium">{t("tablesHeading", { count: tables.length })}</h3>
        {tables.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noTables")}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {tables.map((table, index) => {
              const stats = getTableStats(table)
              const visibleRows = table.rows.slice(0, MAX_PREVIEW_ROWS)
              const hiddenRows = table.rows.length - visibleRows.length
              return (
                <div
                  key={`${table.startIndex}-${index}`}
                  className="flex flex-col gap-1.5"
                  data-testid="twin-source-preview-table"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground text-xs">
                      {t("tableStats", {
                        rows: stats.rowCount,
                        cols: stats.columnCount,
                        numeric: stats.numericColumnCount,
                      })}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={() => void handleCopy(table, index)}
                      data-testid={`twin-source-preview-copy-${index}`}
                    >
                      {copiedIndex === index ? (
                        <>
                          <CheckIcon className="size-3.5" aria-hidden />
                          {t("copied")}
                        </>
                      ) : (
                        <>
                          <CopyIcon className="size-3.5" aria-hidden />
                          {t("copyMarkdown")}
                        </>
                      )}
                    </Button>
                  </div>
                  <div className="overflow-x-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {table.headers.map((header, colIndex) => (
                            <TableHead key={colIndex}>{header}</TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleRows.map((row, rowIndex) => (
                          <TableRow key={rowIndex}>
                            {row.map((cell, cellIndex) => (
                              <TableCell key={cellIndex}>{cell}</TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {hiddenRows > 0 ? (
                    <p className="text-muted-foreground text-xs">
                      {t("moreRows", { count: hiddenRows })}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="flex min-h-0 flex-col gap-2">
        <h3 className="text-sm font-medium">{t("contentHeading")}</h3>
        <ScrollArea className={`${bodyHeightClassName} rounded-md border`}>
          <pre
            className="p-3 text-xs break-words whitespace-pre-wrap"
            data-testid="twin-source-preview-body"
          >
            {truncatedBody}
          </pre>
        </ScrollArea>
        {bodyTruncated ? (
          <p className="text-muted-foreground text-xs">
            {t("contentTruncated", { count: MAX_PREVIEW_CHARS })}
          </p>
        ) : null}
      </section>
    </>
  )
}
