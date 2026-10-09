"use client"

/**
 * Sticky header for one section of the Inbox conversation list.
 *
 * A heading row, not a card: the list is a flat divided run, and the header
 * is what tells the reader where one group ends and the next begins while
 * scrolling. It sticks to the top of the scroller so the group of the row
 * under the reader's eye is always named.
 *
 * Carries: the disclosure (whole label is the toggle, with `aria-expanded` and
 * `aria-controls` pointing at the section's list), the row count, an unread
 * count when it is non-zero, and — for adapter / platform sections — a link
 * that opens that scope as its own route.
 *
 * `Surface layer="base"` rather than a hardcoded `bg-background`: the wallpaper
 * layer retunes surfaces through their tier (ADR-0148), and a sticky band that
 * stayed opaque over a translucent pane would read as a hole.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArrowUpRightIcon, ChevronRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"

export interface ConversationSectionHeaderProps {
  /** Section id; also used to build the DOM ids the disclosure points at. */
  sectionId: string
  label: string
  /** Leading glyph (platform badge, status icon). Decorative. */
  icon?: React.ReactNode
  count: number
  /** Conversations in the section with unread messages; hidden when 0. */
  unreadCount?: number
  collapsed: boolean
  onToggle: () => void
  /** The id of the element this header collapses. */
  controlsId: string
  /** When set, a trailing link opens this section as its own scoped route. */
  scopeHref?: string
}

export function ConversationSectionHeader({
  sectionId,
  label,
  icon,
  count,
  unreadCount = 0,
  collapsed,
  onToggle,
  controlsId,
  scopeHref,
}: ConversationSectionHeaderProps) {
  const t = useTranslations("inbox.sections")
  const scopeLabel = t("openScope", { name: label })

  return (
    <Surface
      asChild
      layer="base"
      radius="none"
      className="sticky top-0 z-10 flex h-8 items-center gap-1 border-b px-1.5"
    >
      <div data-testid={`conversation-section-header-${sectionId}`}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 min-w-0 flex-1 justify-start gap-1.5 px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={controlsId}
          aria-label={t(collapsed ? "expand" : "collapse", { name: label, count })}
          data-testid={`conversation-section-toggle-${sectionId}`}
        >
          <ChevronRightIcon
            className={cn("size-3 shrink-0 transition-transform", !collapsed && "rotate-90")}
            aria-hidden
          />
          {icon ? (
            <span className="flex shrink-0 items-center" aria-hidden>
              {icon}
            </span>
          ) : null}
          <span className="truncate">{label}</span>
          <span
            className="shrink-0 tabular-nums text-muted-foreground/80"
            data-testid={`conversation-section-count-${sectionId}`}
          >
            {count}
          </span>
          {unreadCount > 0 ? (
            <span
              className="ms-1 shrink-0 rounded-pill bg-primary/10 px-1.5 text-[10px] font-semibold leading-4 text-primary tabular-nums"
              data-testid={`conversation-section-unread-${sectionId}`}
            >
              {t("unreadCount", { count: unreadCount })}
            </span>
          ) : null}
        </Button>
        {scopeHref ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground"
              >
                <Link
                  href={scopeHref}
                  aria-label={scopeLabel}
                  data-testid={`conversation-section-scope-${sectionId}`}
                >
                  <ArrowUpRightIcon className="size-3.5" aria-hidden />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{scopeLabel}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </Surface>
  )
}
