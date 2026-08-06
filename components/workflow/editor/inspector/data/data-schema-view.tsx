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
import {
  SchemaDisplay,
  SchemaDisplayContent,
  SchemaDisplayProperty,
} from "@/components/ai-elements/schema-display"

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
    <SchemaDisplay
      className="rounded-none border-0 bg-transparent"
      data-testid="data-schema-view"
      method="GET"
      path={sourceNodeId}
    >
      <SchemaDisplayContent className="divide-y-0 space-y-0.5">
        {rows.map((row) => (
          <SchemaDisplayProperty
            key={row.path}
            {...exprDragProps(sourceNodeId, [...basePrefix, ...row.segments])}
            title={t("dragHint")}
            data-testid="data-field-row"
            className={cn(
              "cursor-grab rounded py-1 pr-1.5 text-xs [&>div]:gap-2 [&>div]:text-xs",
              "hover:bg-accent/50 active:cursor-grabbing"
            )}
            description={row.sample}
            name={row.path}
            type={row.type}
          />
        ))}
      </SchemaDisplayContent>
    </SchemaDisplay>
  )
}
