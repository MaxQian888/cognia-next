"use client"

/**
 * The device rail: search, filters, and the rows grouped by kind.
 *
 * Grouped rather than flat because the kinds answer different questions — a
 * phone is something you grant, a Host is something you drive — and a single
 * ordered list makes the reader re-derive which is which on every row.
 * Within a group the order is `buildDeviceRows`': live before dormant, so the
 * machines that can actually take work are at the top of each section.
 *
 * The filters are chips with counts rather than a dropdown. The dropdown
 * listed all five kinds whatever the fleet held, so "Execution worker" was
 * offered to an account with no workers and picking it produced an empty
 * list; and it hid the one number a rail is scanned for, how many of each
 * there are. A chip appears only for a kind the fleet has, and "Needs
 * attention" appears only while something does (or while it is the active
 * filter, so it can be switched back off).
 *
 * The rail is a list of buttons, so Tab reaches it once and the arrow keys
 * move through it, the way every other list in the app moves. Selecting a row
 * moves focus with it, so the next arrow press continues from there.
 *
 * While the first read is in flight the rail says so with placeholder rows
 * under whatever is already known (this machine is always known). Without
 * them a slow host read looked like a finished fleet of one, and a filter
 * that matched nothing yet said "No device matches" about rows that had not
 * arrived.
 */

import { useMemo, useRef, type KeyboardEvent, type ReactNode } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useDeferredLoading } from "@/hooks/ui/use-deferred-loading"
import { rowNeedsAttention } from "@/lib/devices/build-device-rows"
import type { DeviceKind, DeviceRow } from "@/lib/devices/types"
import { cn } from "@/lib/utils"
import type { DeviceKindFilter } from "@/stores/devices/device-console-store"

import { DeviceRowButton } from "./device-row"

// SSH hosts come last: they are the one group that cannot run anything, so
// they belong below the machines that can rather than interleaved with them.
const GROUP_ORDER: readonly DeviceKind[] = [
  "local",
  "remote-host",
  "paired-device",
  "worker",
  "ssh-host",
]

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
  kindFilter: DeviceKindFilter,
  attentionOnly = false
): DeviceRow[] {
  return rows.filter(
    (row) =>
      (kindFilter === "all" || row.kind === kindFilter) &&
      (!attentionOnly || rowNeedsAttention(row)) &&
      matchesDeviceSearch(row, search)
  )
}

/** How many rows of each kind the fleet holds, in rail order, zeros dropped. */
export function countDeviceKinds(
  rows: readonly DeviceRow[]
): { kind: DeviceKind; count: number }[] {
  return GROUP_ORDER.map((kind) => ({
    kind,
    count: rows.filter((row) => row.kind === kind).length,
  })).filter((entry) => entry.count > 0)
}

/** The row to move to for a navigation key, or `null` for any other key. */
export function nextRowRef(
  refs: readonly string[],
  current: string | null,
  key: string
): string | null {
  if (refs.length === 0) return null
  const index = current ? refs.indexOf(current) : -1
  switch (key) {
    case "ArrowDown":
      return refs[Math.min(refs.length - 1, index + 1)] ?? null
    case "ArrowUp":
      return refs[index <= 0 ? 0 : index - 1] ?? null
    case "Home":
      return refs[0] ?? null
    case "End":
      return refs[refs.length - 1] ?? null
    default:
      return null
  }
}

/** Two placeholder rows in the shape of `DeviceRowButton`, announced once. */
function LoadingRows() {
  const t = useTranslations("devices.listPane")
  return (
    <div role="status" className="space-y-0.5 px-1" data-testid="device-list-loading">
      <span className="sr-only">{t("loading")}</span>
      {[0, 1].map((index) => (
        <div key={index} aria-hidden className="flex items-start gap-2.5 px-1.5 py-2">
          <Skeleton className="mt-0.5 size-4 rounded-control" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  )
}

export interface DeviceListPaneProps {
  rows: readonly DeviceRow[]
  /** The first read is still in flight: rows may be only what is known locally. */
  loading?: boolean
  selectedRef: string | null
  search: string
  kindFilter: DeviceKindFilter
  attentionOnly: boolean
  onSearchChange: (value: string) => void
  onKindFilterChange: (value: DeviceKindFilter) => void
  onAttentionOnlyChange: (value: boolean) => void
  onClearFilters: () => void
  onSelect: (ref: string) => void
  /** Fleet-level notices above the rows (e.g. "showing the local record"). */
  notices?: ReactNode
  /** Under the rows: what to do next when the fleet is only this machine. */
  footer?: ReactNode
}

export function DeviceListPane({
  rows,
  loading = false,
  selectedRef,
  search,
  kindFilter,
  attentionOnly,
  onSearchChange,
  onKindFilterChange,
  onAttentionOnlyChange,
  onClearFilters,
  onSelect,
  notices,
  footer,
}: DeviceListPaneProps) {
  const t = useTranslations("devices")
  const list = useRef<HTMLDivElement>(null)
  // Most reads settle within a frame (the Dexie mirror answers first), so the
  // placeholders only appear for a wait the eye would actually notice.
  const showLoading = useDeferredLoading(loading)

  const visible = useMemo(
    () => filterDeviceRows(rows, search, kindFilter, attentionOnly),
    [rows, search, kindFilter, attentionOnly]
  )

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((kind) => ({
        kind,
        rows: visible.filter((row) => row.kind === kind),
      })).filter((group) => group.rows.length > 0),
    [visible]
  )

  const kindCounts = useMemo(() => countDeviceKinds(rows), [rows])
  const attentionCount = useMemo(() => rows.filter(rowNeedsAttention).length, [rows])
  // A filter the fleet no longer has a row for (the last worker was revoked)
  // still shows as a chip, so the reader can see why the list is empty and
  // turn it off.
  const kindChips: { kind: DeviceKind; count: number }[] =
    kindFilter !== "all" && !kindCounts.some((entry) => entry.kind === kindFilter)
      ? [...kindCounts, { kind: kindFilter, count: 0 }]
      : kindCounts
  const filtered = search.trim().length > 0 || kindFilter !== "all" || attentionOnly
  // In rendered order, which is group order, so ↓ goes where the eye goes.
  const orderedRefs = useMemo(
    () => groups.flatMap((group) => group.rows.map((row) => row.ref)),
    [groups]
  )

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextRowRef(orderedRefs, selectedRef, event.key)
    if (!next) return
    event.preventDefault()
    onSelect(next)
    list.current
      ?.querySelector<HTMLButtonElement>(`[data-row-ref="${CSS.escape(next)}"]`)
      ?.focus({ preventScroll: false })
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="device-list-pane">
      <div className="flex shrink-0 flex-col gap-2 border-b p-2.5">
        <Input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("listPane.searchPlaceholder")}
          aria-label={t("listPane.searchAria")}
          className="h-8"
          data-testid="device-search"
        />
        {/* Hidden while the fleet is one kind and nothing needs attention:
            a single "All 1" chip filters nothing. */}
        {kindChips.length > 1 || attentionCount > 0 || attentionOnly ? (
          <div className="flex flex-wrap items-center gap-1" data-testid="device-filters">
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              spacing={1}
              value={kindFilter}
              onValueChange={(value) =>
                // Radix hands back "" when the pressed chip is clicked again;
                // that means "no kind filter", not an unknown kind.
                onKindFilterChange((value || "all") as DeviceKindFilter)
              }
              aria-label={t("listPane.filterAria")}
              className="flex-wrap"
            >
              <ToggleGroupItem
                value="all"
                className="h-6 px-2 text-[11px]"
                data-testid="device-filter-all"
              >
                {t("listPane.filterAll")}
                <span className="tabular-nums text-muted-foreground">{rows.length}</span>
              </ToggleGroupItem>
              {kindChips.map((entry) => (
                <ToggleGroupItem
                  key={entry.kind}
                  value={entry.kind}
                  className="h-6 px-2 text-[11px]"
                  data-testid={`device-filter-${entry.kind}`}
                >
                  {t(`kindPlural.${entry.kind}`)}
                  <span className="tabular-nums text-muted-foreground">{entry.count}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {attentionCount > 0 || attentionOnly ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-pressed={attentionOnly}
                onClick={() => onAttentionOnlyChange(!attentionOnly)}
                className={cn(
                  "h-6 gap-1 px-2 text-[11px] font-normal",
                  attentionOnly
                    ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                    : "text-amber-700 dark:text-amber-400"
                )}
                data-testid="device-filter-attention"
              >
                <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
                {t("listPane.filterAttention")}
                <span className="tabular-nums">{attentionCount}</span>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {notices ? <div className="shrink-0 space-y-2 border-b p-2.5">{notices}</div> : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5" aria-busy={loading || undefined}>
        {visible.length === 0 && loading ? (
          showLoading ? (
            <LoadingRows />
          ) : null
        ) : visible.length === 0 ? (
          <Empty className="border-none">
            <EmptyHeader>
              <EmptyTitle className="text-sm">{t("listPane.emptyTitle")}</EmptyTitle>
              <EmptyDescription className="text-xs">
                {filtered ? t("listPane.emptyFiltered") : t("listPane.emptyBody")}
              </EmptyDescription>
            </EmptyHeader>
            {filtered ? (
              <EmptyContent>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onClearFilters}
                  data-testid="device-clear-filters"
                >
                  {t("listPane.clearFilters")}
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : (
          <div
            ref={list}
            role="group"
            aria-label={t("listPane.label")}
            onKeyDown={onListKeyDown}
            data-testid="device-rows"
          >
            {groups.map((group) => (
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
            ))}
            {showLoading ? <LoadingRows /> : null}
          </div>
        )}
        {footer && !loading ? <div className="p-1.5 pt-3">{footer}</div> : null}
      </div>
    </div>
  )
}
