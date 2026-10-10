"use client"

/**
 * Search, filter and layout for the Files page (ADR-0223). The search box
 * writes straight to the store; the view defers the filter pass
 * (`useDeferredValue`) so typing never waits on a large list. Sorting moved to
 * the list's column headers.
 */

import { useTranslations } from "next-intl"
import { LayoutGridIcon, ListIcon, SearchIcon } from "lucide-react"

import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useFilesLibraryStore } from "@/stores/files-library"

import { FilesFilterPopover } from "./files-filter-popover"

export function FilesToolbar() {
  const t = useTranslations("files")
  const search = useFilesLibraryStore((s) => s.search)
  const setSearch = useFilesLibraryStore((s) => s.setSearch)
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

      <FilesFilterPopover />

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
