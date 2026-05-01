"use client"

import { Button } from "@/components/ui/button"
import { getValueByPath, resolveArrayOrPath, resolveStringOrPath } from "@/lib/a2ui/data-model"
import type { A2UIComponentProps, A2UIDataExplorerComponent } from "@/types/a2ui/schema"
import { cn } from "@/lib/utils"

export function A2UIDataExplorer({
  component,
  dataModel,
  onAction,
  onDataChange,
}: A2UIComponentProps<A2UIDataExplorerComponent>) {
  const title = resolveStringOrPath(component.title ?? "", dataModel, "")
  const description = resolveStringOrPath(component.description ?? "", dataModel, "")
  const rows = resolveArrayOrPath(component.data, dataModel, []) as Record<string, unknown>[]
  const sortKey = component.sortKeyPath
    ? getValueByPath<string>(dataModel, component.sortKeyPath)
    : undefined
  const sortDirection = component.sortDirectionPath
    ? getValueByPath<string>(dataModel, component.sortDirectionPath)
    : undefined

  const sortedRows = [...rows].sort((left, right) => {
    if (!sortKey) {
      return 0
    }

    const leftValue = String(left[sortKey] ?? "")
    const rightValue = String(right[sortKey] ?? "")
    const comparison = leftValue.localeCompare(rightValue, undefined, {
      numeric: true,
      sensitivity: "base",
    })

    return sortDirection === "desc" ? comparison * -1 : comparison
  })

  const handleSort = (key: string) => {
    const nextDirection = sortKey === key && sortDirection === "asc" ? "desc" : "asc"

    if (component.sortKeyPath) {
      onDataChange(component.sortKeyPath, key)
    }

    if (component.sortDirectionPath) {
      onDataChange(component.sortDirectionPath, nextDirection)
    }

    if (component.sortAction) {
      onAction(component.sortAction, {
        ...component.actionMeta,
        key,
        direction: nextDirection,
      })
    }
  }

  return (
    <div className="space-y-3">
      {title || description ? (
        <div className="space-y-1">
          {title ? <h4 className="text-sm font-semibold">{title}</h4> : null}
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
      ) : null}
      {sortedRows.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-border/60 bg-background/80">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/40">
              <tr>
                {component.columns.map((column) => (
                  <th key={column.key} className="px-3 py-2 text-left font-medium">
                    {column.sortable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto px-0 py-0 font-medium"
                        onClick={() => handleSort(column.key)}
                      >
                        {column.header}
                      </Button>
                    ) : (
                      column.header
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row, rowIndex) => (
                <tr key={String(row.id ?? rowIndex)} className="border-t border-border/50">
                  {component.columns.map((column) => (
                    <td
                      key={`${String(row.id ?? rowIndex)}-${column.key}`}
                      className={cn("px-3 py-2", column.align === "right" && "text-right")}
                    >
                      {String(row[column.key] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          {component.emptyMessage || "No rows available."}
        </div>
      )}
    </div>
  )
}
