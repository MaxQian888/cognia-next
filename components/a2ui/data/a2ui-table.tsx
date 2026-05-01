"use client"

/**
 * A2UI Table Component
 * Maps to shadcn/ui Table
 */

import React, { useMemo, useState, useCallback, memo } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react"
import type { A2UIComponentProps, A2UITableComponent, A2UITableColumn } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { resolveArrayOrPath } from "@/lib/a2ui/data-model"

type SortDirection = "asc" | "desc" | null

export const A2UITable = memo(function A2UITable({
  component,
  onAction,
  onDataChange,
}: A2UIComponentProps<A2UITableComponent>) {
  const { dataModel } = useA2UIData()
  const t = useTranslations("a2ui")

  // Resolve data - can be static array or data-bound
  const data = useMemo(() => {
    if (Array.isArray(component.data)) {
      return component.data
    }
    return resolveArrayOrPath(component.data, dataModel, [])
  }, [component.data, dataModel])

  const columns = component.columns || []
  const [sortColumn, setSortColumn] = useState<string | null>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>(null)
  const [currentPage, setCurrentPage] = useState(0)
  const [selectedRowKeys, setSelectedRowKeys] = useState<Set<string>>(new Set())
  const pageSize = component.pageSize || 10
  const rowKey = component.rowKey || "id"
  const selectable = component.selectable || false
  const locale = component.locale || {}

  // Sort data
  const sortedData = useMemo(() => {
    if (!sortColumn || !sortDirection) return data

    return [...data].sort((a, b) => {
      const aVal = a[sortColumn]
      const bVal = b[sortColumn]

      if (aVal === bVal) return 0
      if (aVal === null || aVal === undefined) return 1
      if (bVal === null || bVal === undefined) return -1

      const comparison = aVal < bVal ? -1 : 1
      return sortDirection === "asc" ? comparison : -comparison
    })
  }, [data, sortColumn, sortDirection])

  // Paginate data
  const paginatedData = useMemo(() => {
    if (!component.pagination) return sortedData
    const start = currentPage * pageSize
    return sortedData.slice(start, start + pageSize)
  }, [sortedData, currentPage, pageSize, component.pagination])

  const totalPages = Math.ceil(sortedData.length / pageSize)

  const handleSort = useCallback(
    (columnKey: string) => {
      let nextSortColumn: string | null = columnKey
      let nextSortDirection: SortDirection = "asc"

      if (sortColumn === columnKey) {
        if (sortDirection === "asc") {
          nextSortDirection = "desc"
        } else if (sortDirection === "desc") {
          nextSortColumn = null
          nextSortDirection = null
        }
      }

      setSortColumn(nextSortColumn)
      setSortDirection(nextSortDirection)

      if (component.sortAction) {
        onAction(component.sortAction, { column: columnKey, direction: nextSortDirection })
      }
    },
    [sortColumn, sortDirection, component.sortAction, onAction]
  )

  const handleRowClick = useCallback(
    (row: Record<string, unknown>, index: number) => {
      if (component.rowClickAction) {
        onAction(component.rowClickAction, { row, index })
      }
    },
    [component.rowClickAction, onAction]
  )

  // Row selection handlers
  const getRowId = useCallback(
    (row: Record<string, unknown>, index: number): string => {
      return String(row[rowKey] ?? index)
    },
    [rowKey]
  )

  const handleSelectRow = useCallback(
    (rowId: string, checked: boolean) => {
      setSelectedRowKeys((prev) => {
        const next = new Set(prev)
        if (checked) {
          next.add(rowId)
        } else {
          next.delete(rowId)
        }
        // Emit data change for selectedRows binding
        if (
          component.selectedRows &&
          typeof component.selectedRows === "object" &&
          "path" in component.selectedRows
        ) {
          onDataChange(component.selectedRows.path, Array.from(next))
        }
        if (component.selectAction) {
          onAction(component.selectAction, { selectedRows: Array.from(next) })
        }
        return next
      })
    },
    [component.selectedRows, component.selectAction, onAction, onDataChange]
  )

  const handleSelectAll = useCallback(
    (checked: boolean) => {
      if (checked) {
        const allKeys = new Set(paginatedData.map((row, idx) => getRowId(row, idx)))
        setSelectedRowKeys(allKeys)
        if (
          component.selectedRows &&
          typeof component.selectedRows === "object" &&
          "path" in component.selectedRows
        ) {
          onDataChange(component.selectedRows.path, Array.from(allKeys))
        }
      } else {
        setSelectedRowKeys(new Set())
        if (
          component.selectedRows &&
          typeof component.selectedRows === "object" &&
          "path" in component.selectedRows
        ) {
          onDataChange(component.selectedRows.path, [])
        }
      }
    },
    [paginatedData, getRowId, component.selectedRows, onDataChange]
  )

  const isAllSelected =
    paginatedData.length > 0 &&
    paginatedData.every((row, idx) => selectedRowKeys.has(getRowId(row, idx)))
  const isSomeSelected = paginatedData.some((row, idx) => selectedRowKeys.has(getRowId(row, idx)))

  const handlePageChange = useCallback(
    (page: number) => {
      setCurrentPage(page)
      if (component.pageChangeAction) {
        onAction(component.pageChangeAction, { page, pageSize })
      }
    },
    [component.pageChangeAction, onAction, pageSize]
  )

  const renderSortIcon = (column: A2UITableColumn) => {
    if (!column.sortable) return null

    if (sortColumn !== column.key) {
      return <ChevronsUpDown className="ml-1 h-4 w-4 opacity-50" />
    }

    return sortDirection === "asc" ? (
      <ChevronUp className="ml-1 h-4 w-4" />
    ) : (
      <ChevronDown className="ml-1 h-4 w-4" />
    )
  }

  const renderCell = (row: Record<string, unknown>, column: A2UITableColumn): React.ReactNode => {
    const value = row[column.key]

    // Custom renderer
    if (column.render) {
      return column.render(value, row) as React.ReactNode
    }

    // Format based on type
    if (value === null || value === undefined) {
      return <span className="text-muted-foreground">—</span>
    }

    if (column.type === "number") {
      return typeof value === "number" ? value.toLocaleString() : String(value)
    }

    if (column.type === "date") {
      try {
        return new Date(value as string).toLocaleDateString()
      } catch {
        return String(value)
      }
    }

    if (column.type === "boolean") {
      return value ? "✓" : "✗"
    }

    return String(value)
  }

  return (
    <div
      className={cn("w-full", component.className)}
      style={component.style as React.CSSProperties}
    >
      {component.title && <h3 className="mb-2 text-sm font-medium">{component.title}</h3>}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {selectable && (
                <TableHead className="w-[40px]">
                  <Checkbox
                    checked={isAllSelected ? true : isSomeSelected ? "indeterminate" : false}
                    onCheckedChange={(checked) => handleSelectAll(!!checked)}
                    aria-label={locale.selectAll || t("tableSelectAll")}
                  />
                </TableHead>
              )}
              {columns.map((column) => (
                <TableHead
                  key={column.key}
                  className={cn(
                    column.sortable && "cursor-pointer select-none",
                    column.align === "center" && "text-center",
                    column.align === "right" && "text-right"
                  )}
                  style={{ width: column.width }}
                  onClick={() => column.sortable && handleSort(column.key)}
                >
                  <div className="flex items-center">
                    {column.header || column.key}
                    {renderSortIcon(column)}
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedData.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length + (selectable ? 1 : 0)}
                  className="h-24 text-center text-muted-foreground"
                >
                  {component.emptyMessage || locale.empty || t("tableEmpty")}
                </TableCell>
              </TableRow>
            ) : (
              paginatedData.map((row, index) => {
                const rid = getRowId(row, index)
                const isSelected = selectedRowKeys.has(rid)
                return (
                  <TableRow
                    key={(row[rowKey] as string | number) ?? index}
                    className={cn(
                      component.rowClickAction && "cursor-pointer hover:bg-muted/50",
                      isSelected && "bg-muted/30"
                    )}
                    onClick={() => handleRowClick(row, index)}
                  >
                    {selectable && (
                      <TableCell className="w-[40px]">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={(checked) => handleSelectRow(rid, !!checked)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={
                            locale.selectRow
                              ? `${locale.selectRow} ${rid}`
                              : `${t("tableSelectRow")} ${rid}`
                          }
                        />
                      </TableCell>
                    )}
                    {columns.map((column) => (
                      <TableCell
                        key={column.key}
                        className={cn(
                          column.align === "center" && "text-center",
                          column.align === "right" && "text-right"
                        )}
                      >
                        {renderCell(row, column)}
                      </TableCell>
                    ))}
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {component.pagination && totalPages > 1 && (
        <div className="flex items-center justify-between px-2 py-4">
          <p className="text-sm text-muted-foreground">
            {locale.showing
              ? locale.showing
                  .replace("{start}", String(currentPage * pageSize + 1))
                  .replace(
                    "{end}",
                    String(Math.min((currentPage + 1) * pageSize, sortedData.length))
                  )
                  .replace("{total}", String(sortedData.length))
              : t("tableShowing", {
                  start: currentPage * pageSize + 1,
                  end: Math.min((currentPage + 1) * pageSize, sortedData.length),
                  total: sortedData.length,
                })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(currentPage - 1)}
              disabled={currentPage === 0}
            >
              {locale.previous || t("tablePrevious")}
            </Button>
            <span className="text-sm">
              {locale.page
                ? locale.page
                    .replace("{current}", String(currentPage + 1))
                    .replace("{total}", String(totalPages))
                : t("tablePage", { current: currentPage + 1, total: totalPages })}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePageChange(currentPage + 1)}
              disabled={currentPage >= totalPages - 1}
            >
              {locale.next || t("tableNext")}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
})
