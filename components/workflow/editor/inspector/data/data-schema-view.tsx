"use client"

/**
 * Schema lens — every flattened path into an item, as a draggable chip. Best
 * for mapping deeply-nested fields into expressions without typing accessors.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { flattenSchema } from "@/lib/workflow/editor/node-io-data"
import type { PathSegment } from "@/lib/workflow/editor/expr-ref"
import { cn } from "@/lib/utils"
import { exprDragProps } from "./drag-props"

export function DataSchemaView({
  sourceNodeId,
  item,
  basePrefix,
}: {
  sourceNodeId: string
  item: unknown
  basePrefix: ReadonlyArray<PathSegment>
}) {
  const t = useTranslations("workflows.dataView")
  const rows = useMemo(() => flattenSchema(item), [item])

  if (rows.length === 0) {
    return <p className="px-1 py-2 text-xs italic text-muted-foreground">{t("schemaEmpty")}</p>
  }

  return (
    <ul className="space-y-0.5" data-testid="data-schema-view">
      {rows.map((row) => (
        <li
          key={row.path}
          {...exprDragProps(sourceNodeId, [...basePrefix, ...row.segments])}
          title={t("dragHint")}
          data-testid="data-field-row"
          className={cn(
            "flex items-center gap-2 rounded px-1.5 py-1 text-xs cursor-grab",
            "hover:bg-accent/50 active:cursor-grabbing"
          )}
        >
          <span className="font-mono text-foreground/80 break-all">{row.path}</span>
          <span className="ml-auto shrink-0 text-[10px] uppercase text-muted-foreground">
            {row.type}
          </span>
          <span className="shrink-0 max-w-[40%] truncate font-mono text-muted-foreground">
            {row.sample}
          </span>
        </li>
      ))}
    </ul>
  )
}
