"use client"

/**
 * The Files list (ADR-0223): subfolders first (inside a folder), then one row
 * per item, under headers that sort by name, source, last activity, size and
 * type. A header click cycles its column's natural direction, the reverse,
 * and back to the view's own order (Suggested score, Trash date, …).
 *
 * Columns give way to the name as the page narrows (container queries on
 * `@container/files`): the source at `@xl`, the size at `@2xl`, the type at
 * `@3xl`. The name, last activity and menu always stay.
 */

import { useTranslations } from "next-intl"
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { RangeSelectionMouseEvent } from "@/hooks/ui/use-range-selection"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import { ariaSortFor, nextFilesSort } from "@/lib/files-library/column-sort"
import type { FilesEntry, FilesSort, FilesSortKey } from "@/lib/files-library/types"
import { cn } from "@/lib/utils"

import { FilesFolderRow } from "./files-folder-item"
import { FilesRow } from "./files-row"

export interface FilesListTableProps {
  /** The rows drawn (one page of the view, in order). */
  entries: readonly FilesEntry[]
  /** Subfolders of the folder in view, drawn above the items. */
  folders: readonly LibraryFolder[]
  folderItemCounts: ReadonlyMap<string, number>
  /** How many items the view holds — what select-all selects. */
  totalInView: number
  selectedCount: number
  isSelected: (key: string) => boolean
  onSelect: (key: string, event: RangeSelectionMouseEvent) => void
  onSelectAll: () => void
  onClearSelection: () => void
  previewedKey: string | null
  sort: FilesSort | null
  onSort: (sort: FilesSort | null) => void
  /** The Trash: the date column reads "Deleted". */
  trash: boolean
  actions: FilesActions
  now: number
}

export function FilesListTable({
  entries,
  folders,
  folderItemCounts,
  totalInView,
  selectedCount,
  isSelected,
  onSelect,
  onSelectAll,
  onClearSelection,
  previewedKey,
  sort,
  onSort,
  trash,
  actions,
  now,
}: FilesListTableProps) {
  const t = useTranslations("files")
  const allSelected = totalInView > 0 && selectedCount >= totalInView
  const someSelected = selectedCount > 0 && !allSelected

  const sortHeader = (key: FilesSortKey, label: string, className?: string) => {
    const direction = ariaSortFor(sort, key)
    const Arrow =
      direction === "ascending"
        ? ArrowUpIcon
        : direction === "descending"
          ? ArrowDownIcon
          : ArrowUpDownIcon
    return (
      <TableHead aria-sort={direction} className={className}>
        <button
          type="button"
          onClick={() => onSort(nextFilesSort(sort, key))}
          aria-label={t("columns.sortBy", { column: label })}
          className={cn(
            "-mx-1 inline-flex items-center gap-1 rounded-sm px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
            direction !== "none" && "text-foreground"
          )}
          data-testid={`files-sort-${key}`}
        >
          {label}
          <Arrow className={cn("size-3", direction === "none" && "opacity-40")} aria-hidden />
        </button>
      </TableHead>
    )
  }

  return (
    <div className="@container/files" data-testid="files-list">
      <Table className="table-fixed">
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead className="w-10 pr-0">
              <Checkbox
                checked={allSelected ? true : someSelected ? "indeterminate" : false}
                onCheckedChange={() => (allSelected ? onClearSelection() : onSelectAll())}
                disabled={totalInView === 0}
                aria-label={t("selection.selectAll")}
                data-testid="files-select-all"
              />
            </TableHead>
            {sortHeader("name", t("columns.name"), "w-auto")}
            {sortHeader("source", t("columns.source"), "hidden w-48 @xl/files:table-cell")}
            {sortHeader("activity", trash ? t("columns.deleted") : t("columns.activity"), "w-28")}
            {sortHeader("size", t("columns.size"), "hidden w-24 @2xl/files:table-cell")}
            {sortHeader("type", t("columns.type"), "hidden w-28 @3xl/files:table-cell")}
            <TableHead className="w-10">
              <span className="sr-only">{t("columns.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {folders.map((folder) => (
            <FilesFolderRow
              key={folder.id}
              folder={folder}
              itemCount={folderItemCounts.get(folder.id) ?? 0}
              actions={actions}
              now={now}
            />
          ))}
          {entries.map((entry) => (
            <FilesRow
              key={entry.key}
              entry={entry}
              actions={actions}
              previewed={entry.key === previewedKey}
              selected={isSelected(entry.key)}
              onSelect={onSelect}
              now={now}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
