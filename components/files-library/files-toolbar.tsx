"use client"

/**
 * Search, type filter, sort, workspace scope and layout for the Files page.
 * The search box writes straight to the store; the page defers the filter
 * pass (`useDeferredValue`) so typing never waits on a large grid.
 */

import { useTranslations } from "next-intl"
import { LayoutGridIcon, ListIcon, SearchIcon } from "lucide-react"

import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  FILES_SORTS,
  FILES_TYPE_FILTERS,
  type FilesProjectScope,
  type FilesSort,
  type FilesTypeFilter,
} from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

export function FilesToolbar() {
  const t = useTranslations("files")
  const search = useFilesLibraryStore((s) => s.search)
  const setSearch = useFilesLibraryStore((s) => s.setSearch)
  const type = useFilesLibraryStore((s) => s.type)
  const setType = useFilesLibraryStore((s) => s.setType)
  const sort = useFilesLibraryStore((s) => s.sort)
  const setSort = useFilesLibraryStore((s) => s.setSort)
  const projectScope = useFilesLibraryStore((s) => s.projectScope)
  const setProjectScope = useFilesLibraryStore((s) => s.setProjectScope)
  const viewMode = useFilesLibraryStore((s) => s.viewMode)
  const setViewMode = useFilesLibraryStore((s) => s.setViewMode)

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="files-toolbar">
      <InputGroup className="h-8 w-full min-w-0 sm:w-64">
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("search.placeholder")}
          aria-label={t("search.aria")}
          data-testid="files-search"
        />
      </InputGroup>

      <Select value={type} onValueChange={(value) => setType(value as FilesTypeFilter)}>
        <SelectTrigger size="sm" aria-label={t("type.label")} data-testid="files-type-filter">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FILES_TYPE_FILTERS.map((id) => (
            <SelectItem key={id} value={id}>
              {t(`type.${id}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={sort} onValueChange={(value) => setSort(value as FilesSort)}>
        <SelectTrigger size="sm" aria-label={t("sort.label")} data-testid="files-sort">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FILES_SORTS.map((id) => (
            <SelectItem key={id} value={id}>
              {t(`sort.${id}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={projectScope}
        onValueChange={(value) => setProjectScope(value as FilesProjectScope)}
      >
        <SelectTrigger size="sm" aria-label={t("scope.label")} data-testid="files-scope">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="current">{t("scope.current")}</SelectItem>
          <SelectItem value="all">{t("scope.all")}</SelectItem>
        </SelectContent>
      </Select>

      <ToggleGroup
        type="single"
        size="sm"
        value={viewMode}
        onValueChange={(value) => {
          if (value === "grid" || value === "list") setViewMode(value)
        }}
        aria-label={t("view.toggleAria")}
      >
        <ToggleGroupItem value="grid" aria-label={t("view.grid")} data-testid="files-view-grid">
          <LayoutGridIcon className="size-3.5" />
        </ToggleGroupItem>
        <ToggleGroupItem value="list" aria-label={t("view.list")} data-testid="files-view-list">
          <ListIcon className="size-3.5" />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}
