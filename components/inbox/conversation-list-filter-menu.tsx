"use client"

/**
 * Filter control for the conversation list header.
 *
 * Replaces four permanently-visible `Toggle` chips. Together with the uppercase
 * micro-heading and the search box they made ~110px of chrome sit above the
 * first conversation; mature clients show search plus a filter affordance and
 * surface the *active* filters as removable pills instead.
 *
 * Keeps the four `conversation-filter-{chip}` test ids so the list's existing
 * chip coverage carries over unchanged.
 */

import { useTranslations } from "next-intl"
import { ListFilterIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export type ConversationFilterChip = "unread" | "pinned" | "pending" | "snoozed"

export const CONVERSATION_FILTER_CHIPS = [
  "unread",
  "pinned",
  "pending",
  "snoozed",
] as const satisfies readonly ConversationFilterChip[]

export interface ConversationListFilterMenuProps {
  active: ReadonlySet<ConversationFilterChip>
  onToggle: (chip: ConversationFilterChip) => void
  onClear: () => void
}

export function ConversationListFilterMenu({
  active,
  onToggle,
  onClear,
}: ConversationListFilterMenuProps) {
  const t = useTranslations("inbox.conversationList.filter")

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={active.size > 0 ? "secondary" : "ghost"}
          size="sm"
          className="h-8 shrink-0 gap-1 px-2 text-xs"
          aria-label={t("aria")}
          data-testid="conversation-filter-menu"
        >
          <ListFilterIcon className="size-3.5" aria-hidden />
          {/* The label drops out below 15rem of list width — the rail can be
              as narrow as ~123px at `listMin`. Same trick as
              `provider-sidebar-item.tsx`. */}
          <span className="hidden @[15rem]/conversation-list:inline">{t("button")}</span>
          {active.size > 0 && (
            <Badge
              variant="secondary"
              className="h-4 min-w-4 px-1 text-[10px] leading-none"
              aria-label={t("badgeAria", { count: active.size })}
              data-testid="conversation-filter-count"
            >
              {active.size}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-xs">{t("aria")}</DropdownMenuLabel>
        {CONVERSATION_FILTER_CHIPS.map((chip) => (
          <DropdownMenuCheckboxItem
            key={chip}
            checked={active.has(chip)}
            // Without this the menu closes after each pick, so combining two
            // filters would take two trips.
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={() => onToggle(chip)}
            data-testid={`conversation-filter-${chip}`}
          >
            {t(chip)}
          </DropdownMenuCheckboxItem>
        ))}
        {active.size > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onClear} data-testid="conversation-filter-clear">
              {t("clear")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
