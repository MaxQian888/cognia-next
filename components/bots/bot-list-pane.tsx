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

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
}: BotListPaneProps) {
  const t = useTranslations("bots")

  const visible = useMemo(
    () => filterBotRows(rows, search, statusFilter),
    [rows, search, statusFilter]
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bot-list-pane">
      <div className="flex shrink-0 flex-col gap-2 border-b p-2.5">
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("listPane.searchPlaceholder")}
          aria-label={t("listPane.searchAria")}
          className="h-8"
          data-testid="bot-search"
        />
        <Select
          value={statusFilter}
          onValueChange={(value) => onStatusFilterChange(value as BotStatusFilter)}
        >
          <SelectTrigger className="h-8 text-xs" aria-label={t("listPane.filterAria")}>
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
