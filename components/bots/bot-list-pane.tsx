"use client"

/**
 * The Bots rail: search, a status filter, and the rows.
 *
 * Flat rather than grouped, unlike `/devices`. The kinds there answer
 * different questions (a phone is something you grant, a Host is something you
 * drive), while every row here is the same kind of thing and the only axis a
 * reader sorts by is "does this one need me". That axis is the filter, and the
 * order is the query's: most recently touched first.
 */

import { useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  BOT_STATUS_FILTERS,
  filterBotRows,
  type BotConsoleRow,
  type BotStatusFilter,
} from "@/lib/bot/console/bot-rows"

import { BotRowButton } from "./bot-row"

export interface BotListPaneProps {
  rows: readonly BotConsoleRow[]
  selectedId: string | null
  search: string
  statusFilter: BotStatusFilter
  loading?: boolean
  onSearchChange: (value: string) => void
  onStatusFilterChange: (value: BotStatusFilter) => void
  onSelect: (installationId: string) => void
  /**
   * Opens the install sheet from an empty (unfiltered) list. On the phone the
   * list IS the page, and "install a plugin to get started" with no button
   * under it left only a corner glyph to find.
   */
  onInstall?: () => void
}

export function BotListPane({
  rows,
  selectedId,
  search,
  statusFilter,
  loading = false,
  onSearchChange,
  onStatusFilterChange,
  onSelect,
  onInstall,
}: BotListPaneProps) {
  const t = useTranslations("bots")
  const searchRef = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  /**
   * The rail spends most of its life on the filter, so search is a collapsed
   * affordance until asked for. Focused OR carrying a query keeps it open —
   * collapsing on blur while a query is set would hide what the list is
   * filtered by.
   */
  const expanded = searchOpen || search.trim() !== ""

  const visible = useMemo(
    () => filterBotRows(rows, search, statusFilter),
    [rows, search, statusFilter]
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bot-list-pane">
      <div className="relative flex shrink-0 items-center border-b p-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Keeps the icon's seat in flow so the row's geometry never moves
              when the overlaying field opens over it. */}
          <span aria-hidden className="size-8 shrink-0" />
          <Select
            value={statusFilter}
            onValueChange={(value) => onStatusFilterChange(value as BotStatusFilter)}
          >
            <SelectTrigger
              // `size` drives `data-[size=*]:h-*`, which out-specifies an
              // `h-*` class — an h-8 override here silently loses to h-9.
              size="sm"
              className="min-w-0 flex-1 text-xs"
              aria-label={t("listPane.filterAria")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BOT_STATUS_FILTERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`listPane.filter.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* The field is an overlay that grows rightward from the icon's seat,
            covering the filter: two controls, one row, and the reveal reads as
            the rail reaching for search rather than swapping bars. It stretches
            the full content height (inset-y matches the row's padding) instead
            of pinning h-8, so a taller control underneath can never peek out. */}
        <div
          className={cn(
            "absolute inset-y-2.5 left-2.5 z-10 flex items-center overflow-hidden rounded-md transition-[width,border-color,box-shadow] ease-out [transition-duration:calc(200ms*var(--motion-duration-scale,1))]",
            expanded
              ? "w-[calc(100%-1.25rem)] border bg-background shadow-xs"
              : "w-8 border-transparent"
          )}
        >
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label={t("listPane.searchAria")}
            aria-expanded={expanded}
            tabIndex={expanded ? -1 : 0}
            onClick={() => {
              // The icon toggles: expanded → fold the field away (which also
              // drops the query — a collapsed icon must not hide a live
              // filter); collapsed → open it and hand focus to the input.
              if (expanded) {
                onSearchChange("")
                setSearchOpen(false)
                searchRef.current?.blur()
              } else {
                setSearchOpen(true)
                searchRef.current?.focus()
              }
            }}
            data-testid="bot-search-open"
          >
            <SearchIcon className="size-4" aria-hidden />
          </Button>
          <Input
            ref={searchRef}
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setSearchOpen(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                onSearchChange("")
                event.currentTarget.blur()
              }
            }}
            placeholder={t("listPane.searchPlaceholder")}
            aria-label={t("listPane.searchAria")}
            tabIndex={expanded ? 0 : -1}
            className="h-8 min-w-40 flex-1 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
            data-testid="bot-search"
          />
          {search ? (
            <Button
              variant="ghost"
              size="icon"
              className="mr-1 size-6 shrink-0"
              aria-label={t("listPane.searchClearAria")}
              onClick={() => {
                onSearchChange("")
                searchRef.current?.focus()
              }}
              data-testid="bot-search-clear"
            >
              <XIcon className="size-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {loading ? (
          // Three bars, not a spinner: the rail's shape is known before its
          // contents are, and a spinner here reads as "something is wrong".
          <div className="flex flex-col gap-1.5 p-1" data-testid="bot-list-loading">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : visible.length === 0 ? (
          <Empty className="border-none">
            <EmptyHeader>
              <EmptyTitle className="text-sm">{t("listPane.emptyTitle")}</EmptyTitle>
              <EmptyDescription className="text-xs">
                {search.trim() || statusFilter !== "all"
                  ? t("listPane.emptyFiltered")
                  : t("listPane.emptyBody")}
              </EmptyDescription>
            </EmptyHeader>
            {onInstall && !search.trim() && statusFilter === "all" && rows.length === 0 ? (
              <EmptyContent>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onInstall}
                  data-testid="bot-list-install"
                >
                  {t("install.title")}
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : (
          <div className="flex flex-col gap-0.5">
            {visible.map((row) => (
              <BotRowButton
                key={row.id}
                row={row}
                selected={row.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
