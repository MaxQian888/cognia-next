"use client"

/**
 * Table lens over one item — key / type / value rows. Each row is a drag
 * source that inserts a reference to that field into an expression editor.
 * Non-object items render a single draggable "value" row.
 */

import { useTranslations } from "next-intl"
import { sampleOf, typeOf } from "@/lib/workflow/editor/node-io-data"
import type { PathSegment } from "@/lib/workflow/editor/expr-ref"
import { cn } from "@/lib/utils"
import { exprDragProps } from "./drag-props"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"

export function DataTableView({
  sourceNodeId,
  item,
  basePrefix,
}: {
  sourceNodeId: string
  item: unknown
  /** Segments that prefix every field path (e.g. `[i]` when paging an array). */
  basePrefix: ReadonlyArray<PathSegment>
}) {
  const t = useTranslations("workflows.dataView")

  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const entries = Object.entries(item as Record<string, unknown>)
    if (entries.length === 0) {
      return <p className="px-1 py-2 text-xs italic text-muted-foreground">{t("emptyObject")}</p>
    }
    return (
      <Table className="text-xs" data-testid="data-table-view">
        <TableBody>
          {entries.map(([key, value]) => (
            <FieldRow
              key={key}
              label={key}
              value={value}
              sourceNodeId={sourceNodeId}
              segments={[...basePrefix, key]}
              dragTitle={t("dragHint")}
            />
          ))}
        </TableBody>
      </Table>
    )
  }

  // Primitive / array item — a single draggable value row.
  return (
    <Table className="text-xs" data-testid="data-table-view">
      <TableBody>
        <FieldRow
          label={t("valueLabel")}
          value={item}
          sourceNodeId={sourceNodeId}
          segments={basePrefix}
          dragTitle={t("dragHint")}
        />
      </TableBody>
    </Table>
  )
}

function FieldRow({
  label,
  value,
  sourceNodeId,
  segments,
  dragTitle,
}: {
  label: string
  value: unknown
  sourceNodeId: string
  segments: ReadonlyArray<PathSegment>
  dragTitle: string
}) {
  return (
    <TableRow
      {...exprDragProps(sourceNodeId, segments)}
      title={dragTitle}
      data-testid="data-field-row"
      className={cn(
        "cursor-grab border-b last:border-b-0 align-top",
        "hover:bg-accent/50 active:cursor-grabbing"
      )}
    >
      <TableCell className="py-1 pr-2 font-mono font-medium text-foreground/80 whitespace-nowrap">
        {label}
      </TableCell>
      <TableCell className="py-1 pl-1 text-[10px] uppercase text-muted-foreground whitespace-nowrap">
        {typeOf(value)}
      </TableCell>
      <TableCell className="py-1 pl-2 font-mono text-muted-foreground break-all whitespace-normal">
        {sampleOf(value)}
      </TableCell>
    </TableRow>
  )
}
