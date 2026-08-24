"use client"

/**
 * The device rail: search, a kind filter, and the rows grouped by kind.
 *
 * Grouped rather than flat because the kinds answer different questions — a
 * phone is something you grant, a Host is something you drive — and a single
 * ordered list makes the reader re-derive which is which on every row.
 * Within a group the order is `buildDeviceRows`': live before dormant, so the
 * machines that can actually take work are at the top of each section.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { DeviceKind, DeviceRow } from "@/lib/devices/types"
import type { DeviceKindFilter } from "@/stores/devices/device-console-store"

import { DeviceRowButton } from "./device-row"

const GROUP_ORDER: readonly DeviceKind[] = ["local", "remote-host", "paired-device", "worker"]

const KIND_FILTERS: readonly DeviceKindFilter[] = ["all", ...GROUP_ORDER]

/** Case-insensitive match over the fields a person would actually type. */
export function matchesDeviceSearch(row: DeviceRow, needle: string): boolean {
  const query = needle.trim().toLowerCase()
  if (!query) return true
  return [row.label, row.ref, row.baseUrl, row.reportedPlatform, row.platform, row.appVersion]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(query))
}

export function filterDeviceRows(
  rows: readonly DeviceRow[],
  search: string,
  kindFilter: DeviceKindFilter
): DeviceRow[] {
  return rows.filter(
    (row) => (kindFilter === "all" || row.kind === kindFilter) && matchesDeviceSearch(row, search)
  )
}

export interface DeviceListPaneProps {
  rows: readonly DeviceRow[]
  selectedRef: string | null
  search: string
  kindFilter: DeviceKindFilter
  onSearchChange: (value: string) => void
  onKindFilterChange: (value: DeviceKindFilter) => void
  onSelect: (ref: string) => void
}

export function DeviceListPane({
  rows,
  selectedRef,
  search,
  kindFilter,
  onSearchChange,
  onKindFilterChange,
  onSelect,
}: DeviceListPaneProps) {
  const t = useTranslations("devices")

  const visible = useMemo(
    () => filterDeviceRows(rows, search, kindFilter),
    [rows, search, kindFilter]
  )

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((kind) => ({
        kind,
        rows: visible.filter((row) => row.kind === kind),
      })).filter((group) => group.rows.length > 0),
    [visible]
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="device-list-pane">
      <div className="flex shrink-0 flex-col gap-2 border-b p-2.5">
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("listPane.searchPlaceholder")}
          aria-label={t("listPane.searchAria")}
          className="h-8"
          data-testid="device-search"
        />
        <Select
          value={kindFilter}
          onValueChange={(value) => onKindFilterChange(value as DeviceKindFilter)}
        >
          <SelectTrigger className="h-8 text-xs" aria-label={t("listPane.filterAria")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_FILTERS.map((value) => (
              <SelectItem key={value} value={value}>
                {value === "all" ? t("listPane.filterAll") : t(`kind.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {visible.length === 0 ? (
          <Empty className="border-none">
            <EmptyHeader>
              <EmptyTitle className="text-sm">{t("listPane.emptyTitle")}</EmptyTitle>
              <EmptyDescription className="text-xs">
                {search.trim() || kindFilter !== "all"
                  ? t("listPane.emptyFiltered")
                  : t("listPane.emptyBody")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          groups.map((group) => (
            <section key={group.kind} className="mb-2 last:mb-0">
              <h3 className="px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t(`kind.${group.kind}`)}
              </h3>
              <div className="flex flex-col gap-0.5">
                {group.rows.map((row) => (
                  <DeviceRowButton
                    key={row.ref}
                    row={row}
                    selected={row.ref === selectedRef}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
}
