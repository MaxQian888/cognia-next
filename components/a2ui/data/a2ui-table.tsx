"use client"

/**
 * A2UI Table Component
 * Maps to shadcn/ui Table
 */

import React, { useContext, useMemo, useState, useCallback, useRef, memo } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
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
import { A2UIDataCtx } from "@/hooks/a2ui/use-a2ui-context"
import { resolveArrayOrPath, resolveStringOrPath, getValueByPath } from "@/lib/a2ui/data-model"

type SortDirection = "asc" | "desc" | null

/**
 * An un-paginated table with more rows than this switches its body to windowed
 * rendering (spacer-row technique — preserves `<table>` semantics and column
 * alignment). Paginated tables already bound the DOM to `pageSize`, so they are
 * never virtualized and their render path is unchanged.
 */
export const TABLE_VIRTUALIZE_THRESHOLD = 100
/** Estimated row height (px) used to seed the virtualizer before measurement. */
export const ESTIMATED_TABLE_ROW_HEIGHT = 44

export const A2UITable = memo(function A2UITable({
  component,
  dataModel: dataModelProp,
  onAction,
  onDataChange,
}: A2UIComponentProps<A2UITableComponent>) {
  // Prefer the context dataModel when wrapped in an A2UIProvider; fall back to
  // the prop so this table can also be synthesized standalone (e.g. by the
  // RichOutput dispatcher's `data-exploration` profile, which projects its own
  // dataModel through props without a surrounding surface).
  const contextData = useContext(A2UIDataCtx)
  const dataModel = useMemo(
    () => contextData?.dataModel ?? dataModelProp ?? {},
    [contextData?.dataModel, dataModelProp]
  )
  const t = useTranslations("a2ui")

  // Resolve data - can be static array or data-bound
  const data = useMemo(() => {
    if (Array.isArray(component.data)) {
      return component.data
    }
    return resolveArrayOrPath(component.data, dataModel, [])
  }, [component.data, dataModel])

  const columns = component.columns || []
  // Sort state — when `sortKeyPath` / `sortDirectionPath` are set the dataModel
  // is authoritative (explorer mode). Otherwise local state owns sort (paginated
  // table mode).
  const isPathSorted = Boolean(component.sortKeyPath || component.sortDirectionPath)
  const [localSortColumn, setLocalSortColumn] = useState<string | null>(null)
  const [localSortDirection, setLocalSortDirection] = useState<SortDirection>(null)
  const pathSortColumn = component.sortKeyPath
    ? (getValueByPath<string>(dataModel, component.sortKeyPath) ?? null)
    : null
  const pathSortDirection = component.sortDirectionPath
    ? ((getValueByPath<string>(dataModel, component.sortDirectionPath) as SortDirection) ?? null)
    : null
  const sortColumn = isPathSorted ? pathSortColumn : localSortColumn
  const sortDirection = isPathSorted ? pathSortDirection : localSortDirection
  const description = component.description
    ? resolveStringOrPath(component.description, dataModel, "")
    : ""
  const [currentPage, setCurrentPage] = useState(0)
  const [selectedRowKeys, setSelectedRowKeys] = useState<Set<string>>(new Set())
  const pageSize = component.pageSize || 10
  const rowKey = component.rowKey || "id"
  const selectable = component.selectable || false
  const locale = component.locale || {}

  // Sort data
  const sortedData = useMemo(() => {
    if (!sortColumn || !sortDirection) return data

    if (isPathSorted) {
      // Explorer-mode: numeric-aware locale compare (matches former DataExplorer
      // behavior so callers get the same ordering after the merge).
      return [...data].sort((left, right) => {
        const leftValue = String(left[sortColumn] ?? "")
        const rightValue = String(right[sortColumn] ?? "")
        const comparison = leftValue.localeCompare(rightValue, undefined, {
          numeric: true,
          sensitivity: "base",
        })
        return sortDirection === "desc" ? -comparison : comparison
      })
    }

    return [...data].sort((a, b) => {
      const aVal = a[sortColumn]
      const bVal = b[sortColumn]

      if (aVal === bVal) return 0
      if (aVal === null || aVal === undefined) return 1
      if (bVal === null || bVal === undefined) return -1

      const comparison = aVal < bVal ? -1 : 1
      return sortDirection === "asc" ? comparison : -comparison
    })
  }, [data, sortColumn, sortDirection, isPathSorted])

  // Paginate data
  const paginatedData = useMemo(() => {
    if (!component.pagination) return sortedData
    const start = currentPage * pageSize
    return sortedData.slice(start, start + pageSize)
  }, [sortedData, currentPage, pageSize, component.pagination])

  const totalPages = Math.ceil(sortedData.length / pageSize)

  // Row virtualization for large un-paginated tables. The hook is always called
  // (count 0 otherwise) to respect the rules of hooks. Paginated tables keep
  // their original, fully-rendered body.
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldVirtualizeRows =
    !component.pagination && paginatedData.length > TABLE_VIRTUALIZE_THRESHOLD
  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualizeRows ? paginatedData.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_TABLE_ROW_HEIGHT,
    overscan: 10,
  })
  const virtualRows = shouldVirtualizeRows ? rowVirtualizer.getVirtualItems() : []
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0
  const paddingBottom =
    virtualRows.length > 0
      ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
      : 0
  const bodyColSpan = columns.length + (selectable ? 1 : 0)

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

      if (isPathSorted) {
        // Explorer mode: dataModel is authoritative; never touch local state.
        if (component.sortKeyPath) {
          onDataChange(component.sortKeyPath, nextSortColumn ?? "")
        }
        if (component.sortDirectionPath) {
          onDataChange(component.sortDirectionPath, nextSortDirection ?? "asc")
        }
      } else {
        setLocalSortColumn(nextSortColumn)
        setLocalSortDirection(nextSortDirection)
      }

      if (component.sortAction) {
        // Preserve per-mode payload shape so callers don't see a breaking
        // change after the DataExplorer → Table merge: explorer-mode emits
        // `{ key, direction, ...actionMeta }`, paginated-mode emits
        // `{ column, direction }`.
        onAction(
          component.sortAction,
          isPathSorted
            ? { ...component.actionMeta, key: columnKey, direction: nextSortDirection }
            : { column: columnKey, direction: nextSortDirection }
        )
      }
    },
    [
      sortColumn,
      sortDirection,
      isPathSorted,
      component.sortAction,
      component.sortKeyPath,
      component.sortDirectionPath,
      component.actionMeta,
      onAction,
      onDataChange,
    ]
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

  const renderBodyRow = (row: Record<string, unknown>, index: number): React.ReactNode => {
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
                locale.selectRow ? `${locale.selectRow} ${rid}` : `${t("tableSelectRow")} ${rid}`
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
  }

  return (
    <div
      className={cn("w-full", component.className)}
      style={component.style as React.CSSProperties}
    >
      {component.title && <h3 className="mb-1 text-sm font-medium">{component.title}</h3>}
      {description ? <p className="mb-2 text-xs text-muted-foreground">{description}</p> : null}
      <div
        ref={scrollRef}
        className={cn("rounded-md border", shouldVirtualizeRows && "max-h-[480px] overflow-auto")}
      >
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
            ) : shouldVirtualizeRows ? (
              <>
                {paddingTop > 0 && (
                  <TableRow data-testid="a2ui-table-virtual-pad-top">
                    <TableCell
                      colSpan={bodyColSpan}
                      className="border-0 p-0"
                      style={{ height: paddingTop }}
                    />
                  </TableRow>
                )}
                {virtualRows.map((virtualRow) =>
                  renderBodyRow(paginatedData[virtualRow.index], virtualRow.index)
                )}
                {paddingBottom > 0 && (
                  <TableRow data-testid="a2ui-table-virtual-pad-bottom">
                    <TableCell
                      colSpan={bodyColSpan}
                      className="border-0 p-0"
                      style={{ height: paddingBottom }}
                    />
                  </TableRow>
                )}
              </>
            ) : (
              paginatedData.map((row, index) => renderBodyRow(row, index))
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
