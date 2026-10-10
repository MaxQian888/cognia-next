"use client"

/**
 * The Files filter (ADR-0223): file format (any of several), when an item was
 * last modified, its size, and whether the view spans every workspace. The
 * trigger shows how many filters are on; "Reset" clears them and the search.
 * The workspace scope is a remembered preference, so it is not counted and
 * not reset.
 */

import { useTranslations } from "next-intl"
import { ListFilterIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Separator } from "@/components/ui/separator"
import { FILES_FORMATS } from "@/lib/files-library/format"
import {
  FILES_MODIFIED_WITHIN,
  FILES_SIZE_BANDS,
  type FilesModifiedWithin,
  type FilesSizeBand,
} from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

function isModified(value: string): value is FilesModifiedWithin {
  return (FILES_MODIFIED_WITHIN as readonly string[]).includes(value)
}

function isSizeBand(value: string): value is FilesSizeBand {
  return (FILES_SIZE_BANDS as readonly string[]).includes(value)
}

function FilterHeading({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-medium text-muted-foreground">{children}</p>
}

export function FilesFilterPopover() {
  const t = useTranslations("files")
  const filters = useFilesLibraryStore((s) => s.filters)
  const setFilters = useFilesLibraryStore((s) => s.setFilters)
  const resetFilters = useFilesLibraryStore((s) => s.resetFilters)
  const projectScope = useFilesLibraryStore((s) => s.projectScope)
  const setProjectScope = useFilesLibraryStore((s) => s.setProjectScope)
  const active =
    (filters.formats.length > 0 ? 1 : 0) +
    (filters.modified !== "any" ? 1 : 0) +
    (filters.size !== "any" ? 1 : 0)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={active > 0 ? t("filter.labelActive", { count: active }) : t("filter.label")}
          data-testid="files-filter"
        >
          <ListFilterIcon aria-hidden />
          {t("filter.button")}
          {active > 0 ? (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]" aria-hidden>
              {active}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0" data-testid="files-filter-popover">
        <div className="flex flex-col gap-3 p-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2">
              <FilterHeading>{t("filter.format")}</FilterHeading>
            </legend>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              {FILES_FORMATS.map((format) => {
                const id = `files-filter-format-${format}`
                const checked = filters.formats.includes(format)
                return (
                  <div key={format} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={(next) =>
                        setFilters({
                          formats: next
                            ? [...filters.formats, format]
                            : filters.formats.filter((value) => value !== format),
                        })
                      }
                      data-testid={id}
                    />
                    <Label htmlFor={id} className="text-sm font-normal">
                      {t(`formats.${format}`)}
                    </Label>
                  </div>
                )
              })}
            </div>
          </fieldset>
          <Separator />
          <div className="flex flex-col gap-2">
            <FilterHeading>{t("filter.modified")}</FilterHeading>
            <RadioGroup
              value={filters.modified}
              onValueChange={(value) => {
                if (isModified(value)) setFilters({ modified: value })
              }}
              aria-label={t("filter.modified")}
              className="grid grid-cols-2 gap-2"
            >
              {FILES_MODIFIED_WITHIN.map((value) => {
                const id = `files-filter-modified-${value}`
                return (
                  <div key={value} className="flex items-center gap-2">
                    <RadioGroupItem id={id} value={value} data-testid={id} />
                    <Label htmlFor={id} className="text-sm font-normal">
                      {t(`filter.modifiedWithin.${value}`)}
                    </Label>
                  </div>
                )
              })}
            </RadioGroup>
          </div>
          <Separator />
          <div className="flex flex-col gap-2">
            <FilterHeading>{t("filter.size")}</FilterHeading>
            <RadioGroup
              value={filters.size}
              onValueChange={(value) => {
                if (isSizeBand(value)) setFilters({ size: value })
              }}
              aria-label={t("filter.size")}
              className="grid grid-cols-2 gap-2"
            >
              {FILES_SIZE_BANDS.map((value) => {
                const id = `files-filter-size-${value}`
                return (
                  <div key={value} className="flex items-center gap-2">
                    <RadioGroupItem id={id} value={value} data-testid={id} />
                    <Label htmlFor={id} className="text-sm font-normal">
                      {t(`filter.sizes.${value}`)}
                    </Label>
                  </div>
                )
              })}
            </RadioGroup>
          </div>
          <Separator />
          <div className="flex flex-col gap-2">
            <FilterHeading>{t("scope.label")}</FilterHeading>
            <RadioGroup
              value={projectScope}
              onValueChange={(value) => {
                if (value === "current" || value === "all") setProjectScope(value)
              }}
              aria-label={t("scope.label")}
              className="flex flex-col gap-2"
            >
              {(["current", "all"] as const).map((value) => {
                const id = `files-filter-scope-${value}`
                return (
                  <div key={value} className="flex items-center gap-2">
                    <RadioGroupItem id={id} value={value} data-testid={id} />
                    <Label htmlFor={id} className="text-sm font-normal">
                      {t(`scope.${value}`)}
                    </Label>
                  </div>
                )
              })}
            </RadioGroup>
          </div>
        </div>
        <div className="flex justify-end border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={resetFilters}
            disabled={active === 0}
            data-testid="files-filter-reset"
          >
            {t("filter.reset")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
